import * as R from 'ramda';
import { buildModule, buildActionGroup } from 'jantix';
import { Option } from 'funfix-core';
import { PromiseResolveType, UnreachableException } from 'ameo-utils';

import { EffectNode } from 'src/synthDesigner/effects';
import { ADSRValues, buildDefaultAdsrEnvelope } from 'src/controls/adsr';
import { ADSR2Module, ADSRModule } from 'src/synthDesigner/ADSRModule';
import { SynthPresetEntry, SynthVoicePreset } from 'src/redux/modules/presets';
import FMSynth, { Adsr } from 'src/graphEditor/nodes/CustomAudio/FMSynth/FMSynth';
import { AsyncOnce, normalizeEnvelope } from 'src/util';
import { get_synth_designer_audio_connectables } from 'src/synthDesigner';
import { updateConnectables } from 'src/patchNetwork/interface';
import { OverridableAudioParam } from 'src/graphEditor/nodes/util';
import { FilterType, getDefaultFilterParams } from 'src/synthDesigner/filterHelpers';
import {
  AbstractFilterModule,
  buildAbstractFilterModule,
  FilterCSNs,
} from 'src/synthDesigner/biquadFilterModule';
import { buildDefaultADSR2Envelope } from 'src/controls/adsr2/adsr2';

export enum Waveform {
  Sine = 'sine',
  Square = 'square',
  Sawtooth = 'sawtooth',
  Triangle = 'triangle',
  FM = 'fm',
}

export enum EffectType {
  Bitcrusher = 'bitcrusher',
  Distortion = 'distortion',
  Reverb = 'reverb',
}

export interface Effect {
  type: EffectType;
  node: EffectNode;
}

export interface EffectModule {
  effect: Effect;
  params: { [key: string]: number };
  // If true, then the input will be passed through this effect unchanged.
  isBypassed: boolean;
  // A number from 0 to 1 that represents what percentage of the output will be from the effect and
  // what percentage will be from the input passed through unchanged.
  wetness: number;
  effectGainNode: GainNode;
  passthroughGainNode: GainNode;
}

export interface FilterParams {
  type: FilterType;
  frequency: number;
  Q?: number;
  gain: number;
  detune: number;
}

export interface Voice {
  oscillators: OscillatorNode[];
  effects: EffectModule[];
  // The node that is connected to whatever the synth module as a whole is connected to.  Its
  // source is either the end of the effects chain or the inner gain node.
  outerGainNode: GainNode;
  filterNode: AbstractFilterModule;
  gainADSRModule: ADSRModule;
  filterADSRModule: ADSR2Module;
  lastGateOrUngateTime: number;
}

export const PolysynthMod = new AsyncOnce(() => import('src/polysynth'));
interface PolysynthContext {
  module: PromiseResolveType<ReturnType<typeof PolysynthMod.get>>;
  ctxPtr: number;
}

export enum FilterFrequencySource {
  CSNs,
  ADSR,
}

export interface SynthModule {
  waveform: Waveform;
  detune: number;
  detuneCSN: ConstantSourceNode;
  filterBypassed: boolean;
  voices: Voice[];
  fmSynth: FMSynth | null;
  filterParams: FilterParams;
  /**
   * These are the `OverridableAudioParam`s that are exported from the synth module and can be used to
   * control the filter's params either via UI or patch network.
   *
   * They are not used if filter ADSR is enabled, in which case the ADSR has full control over the
   * filter's frequency.
   */
  filterCSNs: FilterCSNs;
  filterFrequencySource: FilterFrequencySource;
  masterGain: number;
  selectedEffectType: EffectType;
  gainEnvelope: ADSRValues;
  gainADSRLength: number;
  filterEnvelope: Adsr;
  filterADSRLength: number;
  pitchMultiplier: number;
  unisonSpreadCents?: number;
}

const ctx = new AudioContext();

const VOICE_COUNT = 10 as const;

/**
 * @returns a new array of filters to replace the old ones if new ones had to be created due to the
 * filter type changing, `null` otherwise
 */
function updateFilterNode<K extends keyof FilterParams>(
  filters: AbstractFilterModule[],
  csns: FilterCSNs,
  key: K,
  val: FilterParams[K]
): AbstractFilterModule[] | null {
  switch (key) {
    case 'type': {
      filters.forEach(filter => filter.destroy());
      return R.range(0, filters.length).map(() => buildAbstractFilterModule(ctx, val as any, csns));
    }
    case 'adsr':
    case 'bypass':
    case 'enable envelope':
    case 'adsr length ms':
    case 'log scale':
      return null;
    case 'q':
    case 'Q':
      csns.Q.manualControl.offset.value = (val as any) ?? 0;
      return null;
    default: {
      const baseParam = csns[key as Exclude<typeof key, 'type'>];
      if (!baseParam) {
        console.error('`updateFilterNode`: unhandled key: ', key);
        return null;
      }
      const param: ConstantSourceNode = baseParam.manualControl;
      param.offset.value = val as number;
      return null;
    }
  }
}

export const serializeSynthModule = (synth: SynthModule) => ({
  unison: synth.voices[0].oscillators.length,
  unisonSpreadCents: synth.unisonSpreadCents,
  fmSynthConfig: synth.fmSynth?.serialize(),
  waveform: synth.waveform,
  detune: synth.detune,
  filter: synth.filterParams,
  masterGain: synth.masterGain,
  selectedEffectType: synth.selectedEffectType,
  gainEnvelope: synth.gainEnvelope,
  gainADSRLength: synth.gainADSRLength,
  filterEnvelope: synth.filterEnvelope,
  filterADSRLength: synth.filterADSRLength,
  pitchMultiplier: synth.pitchMultiplier,
  filterBypassed: synth.filterBypassed,
});

const connectOscillators = (connect: boolean, synth: SynthModule) =>
  synth.voices.forEach((voice, voiceIx) => {
    const voiceDst = synth.filterBypassed ? voice.outerGainNode : voice.filterNode.getInput();

    const fmSynthAWPNode = synth.fmSynth?.getAWPNode();

    if (!connect) {
      try {
        fmSynthAWPNode?.disconnect();
      } catch (_err) {
        // pass
      }

      voice.oscillators.forEach(osc => {
        try {
          osc.disconnect();
        } catch (err) {
          // pass
        }
      });

      return;
    }

    if (synth.waveform === Waveform.FM) {
      if (synth.fmSynth) {
        fmSynthAWPNode?.connect(voiceDst, voiceIx);
      }
    } else {
      voice.oscillators.forEach(osc => osc.connect(voiceDst));
    }
  });

export interface SynthDesignerState {
  synths: SynthModule[];
  wavyJonesInstance: AnalyserNode | undefined;
  spectrumNode: AnalyserNode;
  isHidden: boolean;
  polysynthCtx: PolysynthContext | null;
  vcId: string;
}

const buildDefaultFilterCSNs = (): FilterCSNs => ({
  frequency: new OverridableAudioParam(ctx),
  Q: new OverridableAudioParam(ctx),
  gain: new OverridableAudioParam(ctx),
  detune: new OverridableAudioParam(ctx),
});

const buildDefaultFilterModule = (
  filterType: FilterType,
  filterCSNs: FilterCSNs
): {
  filterParams: FilterParams;
  filterNode: AbstractFilterModule;
} => {
  const filterNode = buildAbstractFilterModule(ctx, filterType, filterCSNs);
  const filterParams = getDefaultFilterParams(filterType);
  filterParams.type = Option.of(filterParams.type).getOrElse(filterType);

  Object.entries(filterParams)
    .filter(([k, _v]) => k !== 'type')
    .forEach(([key, val]) =>
      updateFilterNode([filterNode], filterCSNs, key as keyof typeof filterParams, val)
    );

  return { filterParams, filterNode };
};

const setUnisonSpread = (synth: SynthModule, spreadCents: number) => {
  synth.voices.forEach(voice => {
    const unison = voice.oscillators.length;
    const middleVoiceIx = (unison - 1) / 2;
    if (middleVoiceIx === 0) {
      return;
    }

    voice.oscillators.forEach((osc, i) => {
      const fract = i / middleVoiceIx - 0.5;
      osc.detune.value = fract * spreadCents;
    });
  });
};

const buildDefaultSynthModule = (filterType: FilterType): SynthModule => {
  const filterCSNs = buildDefaultFilterCSNs();
  const { filterParams } = buildDefaultFilterModule(filterType, filterCSNs);

  // Start the filter ADSR module and configure it to modulate the voice's filter node's frequency
  const filterADSRModule = new ADSR2Module(
    ctx,
    {
      minValue: 0,
      maxValue: 10000,
      lengthMs: 2000,
      steps: buildDefaultADSR2Envelope({ phaseIndex: 0 }).steps,
      releaseStartPhase: 0.8,
      logScale: true,
    },
    VOICE_COUNT
  );

  const dummyGain = new GainNode(ctx);
  dummyGain.gain.value = 0;
  dummyGain.connect(ctx.destination);

  const masterGain = 0.0;
  const inst: SynthModule = {
    waveform: Waveform.Sine,
    detune: 0,
    detuneCSN: new ConstantSourceNode(ctx),
    filterBypassed: true,
    voices: R.range(0, VOICE_COUNT).map((_, voiceIndex) => {
      const outerGainNode = new GainNode(ctx);
      outerGainNode.gain.setValueAtTime(0, ctx.currentTime);

      const { filterNode } = buildDefaultFilterModule(filterType, filterCSNs);
      // TODO: Connect ADSR once we can do so intelligently
      filterNode.getOutput().connect(outerGainNode);

      const osc = new OscillatorNode(ctx);
      osc.start();
      osc.connect(outerGainNode);

      // Start the gain ADSR module and configure it to modulate the voice's gain node
      const gainADSRModule = new ADSRModule(ctx, { minValue: 0, maxValue: 1.0, lengthMs: 1000 });
      gainADSRModule.start();
      gainADSRModule.connect(outerGainNode.gain);

      // We connect the ADSR modules to a dummy output in order to drive them for a while so that
      // they can initialize.
      //
      // If we don't do this, they will start off in an invalid state and, naturally, make
      // horrifically loud noises.
      filterADSRModule.getOutput().then(output => output.connect(dummyGain, voiceIndex));
      gainADSRModule.connect(dummyGain);

      setTimeout(() => {
        filterADSRModule.getOutput().then(output => output.disconnect(dummyGain, voiceIndex));
        gainADSRModule.disconnect(dummyGain);
        dummyGain.disconnect();
      }, 1000);

      return {
        oscillators: [osc],
        fmSynth: null,
        effects: [],
        outerGainNode,
        filterNode,
        gainADSRModule,
        filterADSRModule,
        lastGateOrUngateTime: 0,
      };
    }),
    fmSynth: null,
    filterParams,
    filterCSNs,
    filterFrequencySource: FilterFrequencySource.CSNs,
    masterGain,
    selectedEffectType: EffectType.Reverb,
    gainEnvelope: buildDefaultAdsrEnvelope(),
    gainADSRLength: 1000,
    filterEnvelope: buildDefaultADSR2Envelope({ phaseIndex: 0 }),
    filterADSRLength: 1000,
    pitchMultiplier: 1,
  };

  // Connect up + start all the CSNs
  inst.voices.flatMap(R.prop('oscillators')).forEach(osc => inst.detuneCSN.connect(osc.detune));
  inst.detuneCSN.start();

  return inst;
};

export const deserializeSynthModule = (
  {
    waveform,
    unison,
    detune,
    filter: filterParams,
    masterGain,
    selectedEffectType,
    gainEnvelope,
    gainADSRLength,
    filterEnvelope,
    filterADSRLength,
    pitchMultiplier,
    filterBypassed = true,
    unisonSpreadCents = 0,
    fmSynthConfig,
  }: SynthVoicePreset,
  dispatch: (action: { type: 'CONNECT_FM_SYNTH'; synthIx: number }) => void,
  synthIx: number
): SynthModule => {
  const base = buildDefaultSynthModule(filterParams.type);

  const voices = base.voices.map(voice => {
    voice.oscillators.forEach(osc => {
      osc.stop();
      osc.disconnect();
    });

    voice.filterNode.getOutput().connect(voice.outerGainNode);
    Object.entries(filterParams)
      .filter(([k, _v]) => k !== 'type')
      .forEach(([key, val]: [keyof typeof filterParams, any]) =>
        updateFilterNode([voice.filterNode], base.filterCSNs, key, val)
      );

    voice.gainADSRModule.setEnvelope(gainEnvelope);
    voice.gainADSRModule.setLengthMs(gainADSRLength ?? 1000);
    voice.gainADSRModule.setMaxValue(1 + masterGain);

    if ((filterEnvelope as any).attack) {
      filterEnvelope = buildDefaultADSR2Envelope({ phaseIndex: 0 });
    }
    voice.filterADSRModule.setState(filterEnvelope as Adsr);
    voice.filterADSRModule.setLengthMs(filterADSRLength ?? 1000);
    // TODO: Connect filter ADSR module once we can do so intelligently

    return {
      ...voice,
      oscillators: R.range(0, unison).map(() => {
        const osc = new OscillatorNode(ctx);
        osc.type = waveform === Waveform.FM ? Waveform.Sine : waveform;
        osc.detune.setValueAtTime(0, ctx.currentTime);
        base.detuneCSN.connect(osc.detune);
        osc.start();
        osc.connect(filterBypassed ? voice.outerGainNode : voice.filterNode.getInput());
        return osc;
      }),

      effects: [], // TODO
    };
  });

  const synthModule = {
    ...base,
    waveform,
    detune,
    filterBypassed,
    voices,
    fmSynth:
      waveform === Waveform.FM
        ? new FMSynth(ctx, undefined, {
            ...(fmSynthConfig || {}),
            onInitialized: () => dispatch({ type: 'CONNECT_FM_SYNTH', synthIx }),
          })
        : null,
    masterGain,
    selectedEffectType,
    gainEnvelope,
    gainADSRLength: gainADSRLength ?? 1000,
    filterEnvelope: normalizeEnvelope(filterEnvelope),
    filterADSRLength: filterADSRLength ?? 1000,
    filterParams,
    pitchMultiplier: pitchMultiplier ?? 1,
    unisonSpreadCents,
  };
  connectOscillators(false, synthModule);
  connectOscillators(true, synthModule);

  setUnisonSpread(synthModule, unisonSpreadCents);
  return synthModule;
};

export const getInitialSynthDesignerState = (
  addInitialSynth: boolean,
  vcId: string
): SynthDesignerState => ({
  synths: addInitialSynth ? [buildDefaultSynthModule(FilterType.Lowpass)] : [],
  wavyJonesInstance: undefined,
  spectrumNode: new AnalyserNode(new AudioContext()),
  isHidden: false,
  polysynthCtx: null,
  vcId,
});

const getSynth = (index: number, synths: SynthDesignerState['synths']) => {
  const targetSynth = synths[index];
  if (!targetSynth) {
    throw new Error(
      `Tried to access synth index ${index} but it isn't set; only ${synths.length} synths exist`
    );
  }

  return targetSynth;
};

const getEffect = (synthIx: number, effectIx: number, synths: SynthDesignerState['synths']) => {
  const targetSynth = getSynth(synthIx, synths);
  const targetEffect = targetSynth.voices.map(({ effects }) => effects[effectIx]);
  if (!targetEffect) {
    throw new Error(
      `Tried to access effect index ${effectIx} on synth index ${synthIx} but it isn't set; only ${targetSynth.voices[0].effects.length} effects exist`
    );
  }

  return { targetSynth, targetEffect };
};

const setSynth = (
  synthIx: number,
  synth: SynthModule,
  state: SynthDesignerState
): SynthDesignerState => ({
  ...state,
  synths: R.set(R.lensIndex(synthIx), synth, state.synths),
});

const setEffect = (
  synthIx: number,
  effectIx: number,
  effect: EffectModule[],
  state: SynthDesignerState
): SynthDesignerState => {
  const targetSynth = getSynth(synthIx, state.synths);
  const newSynth = {
    ...targetSynth,
    voices: targetSynth.voices.map((voice, i) => ({
      ...voice,
      effects: R.set(R.lensIndex(effectIx), effect[i], voice.effects),
    })),
  };
  return setSynth(synthIx, newSynth, state);
};

const mkSetFreqForOsc = (frequency: number, offset?: number) => (osc: OscillatorNode) =>
  osc.frequency.setValueAtTime(
    frequency,
    Option.of(offset)
      .map(offset => ctx.currentTime + offset)
      .getOrElse(ctx.currentTime)
  );

const actionGroups = {
  SET_STATE: buildActionGroup({
    actionCreator: (state: SynthDesignerState) => ({ type: 'SET_STATE', state }),
    subReducer: (_state: SynthDesignerState, { state }) => state,
  }),
  SET_WAVEFORM: buildActionGroup({
    actionCreator: (
      index: number,
      waveform: Waveform,
      dispatch: (action: { type: 'CONNECT_FM_SYNTH'; synthIx: number }) => void
    ) => ({
      type: 'SET_WAVEFORM',
      index,
      waveform,
      dispatch,
    }),
    subReducer: (state: SynthDesignerState, { index, waveform, dispatch }): SynthDesignerState => {
      const targetSynth = getSynth(index, state.synths);

      if (targetSynth.waveform === waveform) {
        return state;
      }

      // FM SYNTH
      if (waveform === Waveform.FM) {
        connectOscillators(true, targetSynth);

        if (targetSynth.fmSynth) {
          setTimeout(() => dispatch({ type: 'CONNECT_FM_SYNTH', synthIx: index }));
        } else {
          targetSynth.fmSynth = new FMSynth(ctx, undefined, {
            onInitialized: () => dispatch({ type: 'CONNECT_FM_SYNTH', synthIx: index }),
          });
        }

        return setSynth(index, { ...targetSynth, waveform }, state);
      }
      if (targetSynth.waveform === Waveform.FM) {
        connectOscillators(false, targetSynth);

        if (targetSynth.fmSynth) {
          targetSynth.fmSynth?.getAWPNode()?.disconnect();
        } else {
          console.error('Switched off of fm synth voice type without initialize fm synth instance');
        }
      }

      targetSynth.voices.flatMap(R.prop('oscillators')).forEach(osc => (osc.type = waveform));
      return R.set(R.lensPath(['synths', index, 'waveform']), waveform, state);
    },
  }),
  ADD_SYNTH_MODULE: buildActionGroup({
    actionCreator: () => ({ type: 'ADD_SYNTH_MODULE' }),
    subReducer: (state: SynthDesignerState) => {
      const newModule = buildDefaultSynthModule(FilterType.Lowpass);

      return {
        ...state,
        synths: [...state.synths, newModule],
      };
    },
  }),
  DELETE_SYNTH_MODULE: buildActionGroup({
    actionCreator: (index: number) => ({ type: 'DELETE_SYNTH_MODULE', index }),
    subReducer: (state: SynthDesignerState, { index }) => {
      const removedModule = state.synths[index];
      if (!removedModule) {
        console.error(`Tried to remove synth ix ${index} but we only have ${state.synths.length}`);
        return state;
      }

      return {
        ...state,
        synths: R.remove(index, 1, state.synths),
      };
    },
  }),
  ADD_EFFECT: buildActionGroup({
    actionCreator: (synthIx: number, effect: Effect, params: { [key: string]: number }) => ({
      type: 'ADD_EFFECT',
      synthIx,
      effect,
      params,
    }),
    subReducer: (state: SynthDesignerState, { synthIx, effect, params }) => {
      const targetSynth = getSynth(synthIx, state.synths);

      const effectModules: EffectModule[] = targetSynth.voices.map(voice => {
        const synthOutput = Option.of(R.last(voice.effects))
          .map(R.prop('effect'))
          .map(R.prop('node'))
          // TODO: Should work with filter bypassing and probably go after the filter in that case.
          .getOrElse(voice.filterNode.getOutput());

        synthOutput.disconnect();
        synthOutput.connect(effect.node);
        effect.node.connect(voice.outerGainNode);

        const effectGainNode = new GainNode(ctx);
        effectGainNode.gain.setValueAtTime(1, ctx.currentTime);
        const passthroughGainNode = new GainNode(ctx);
        passthroughGainNode.gain.setValueAtTime(0, ctx.currentTime);

        return {
          effect,
          effectGainNode,
          passthroughGainNode,
          wetness: 1,
          isBypassed: false,
          params,
        };
      });

      return setSynth(
        synthIx,
        {
          ...targetSynth,
          voices: targetSynth.voices.map((voice, i) => ({
            ...voice,
            effects: [...voice.effects, effectModules[i]],
          })),
        },
        state
      );
    },
  }),
  REMOVE_EFFECT: buildActionGroup({
    actionCreator: (synthIx: number, effectIndex: number) => ({
      type: 'REMOVE_EFFECT',
      synthIx,
      effectIndex,
    }),
    subReducer: (state: SynthDesignerState, { synthIx, effectIndex }) => {
      const targetSynth = getSynth(synthIx, state.synths);

      const newVoices: Voice[] = targetSynth.voices.map(voice => {
        const removedEffect = voice.effects[effectIndex];
        if (!removedEffect) {
          throw new Error(`No effect at index ${synthIx} for synth index ${effectIndex}`);
        }

        removedEffect.effect.node.disconnect();
        const newSrc = Option.of(voice.effects[synthIx - 1])
          .map(R.prop('effect'))
          .map(R.prop('node'))
          // TODO: Should work with filter bypassing and probably go after the filter in that case.
          .getOrElse(voice.filterNode.getOutput());
        const newDst = Option.of(voice.effects[effectIndex + 1])
          .map(R.prop('effect'))
          .map(R.prop('node'))
          .getOrElse(voice.outerGainNode);

        removedEffect.effect.node.disconnect();
        newSrc.disconnect();
        newSrc.connect(newDst);

        return { ...voice, effects: R.remove(effectIndex, 1, voice.effects) };
      });

      return setSynth(synthIx, { ...targetSynth, voices: newVoices }, state);
    },
  }),
  GATE: buildActionGroup({
    actionCreator: (frequency: number, voiceIx: number, synthIx?: number, offset?: number) => ({
      type: 'GATE',
      frequency,
      voiceIx,
      synthIx,
      offset,
    }),
    subReducer: (
      state: SynthDesignerState,
      { frequency: baseFrequency, voiceIx, synthIx, offset }
    ) => {
      // TODO: Dedup
      if (R.isNil(synthIx)) {
        state.synths.forEach(synth => {
          synth.fmSynth?.onGate(voiceIx);
          const frequency = baseFrequency * synth.pitchMultiplier;

          const targetVoice = synth.voices[voiceIx];
          if (!state.wavyJonesInstance) {
            return state;
          }

          // Trigger gain and filter ADSRs
          targetVoice.gainADSRModule.gate();
          targetVoice.filterADSRModule.gate(voiceIx);
          // We edit state directly w/o updating references because this is only needed internally
          targetVoice.lastGateOrUngateTime = ctx.currentTime;

          if (synth.waveform === Waveform.FM && synth.fmSynth) {
            synth.fmSynth.setFrequency(voiceIx, frequency);
          } else {
            const setFreqForOsc = mkSetFreqForOsc(frequency, offset);
            targetVoice.oscillators.forEach(osc => setFreqForOsc(osc));
          }

          targetVoice.outerGainNode.connect(state.wavyJonesInstance);
        });
      } else {
        const targetSynth = getSynth(synthIx, state.synths);
        targetSynth.fmSynth?.onGate(voiceIx);
        const targetVoice = targetSynth.voices[voiceIx];
        if (!state.wavyJonesInstance) {
          return state;
        }
        targetVoice.outerGainNode.connect(state.wavyJonesInstance);

        // We edit state directly w/o updating references because this is only needed internally
        targetVoice.lastGateOrUngateTime = ctx.currentTime;
        const frequency = baseFrequency * targetSynth.pitchMultiplier;
        const setFreqForOsc = mkSetFreqForOsc(frequency, offset);

        // Trigger gain and filter ADSRs
        targetVoice.gainADSRModule.gate();
        targetVoice.filterADSRModule.gate(voiceIx);

        targetVoice.oscillators.forEach(osc => setFreqForOsc(osc));
      }

      return state;
    },
  }),
  UNGATE: buildActionGroup({
    actionCreator: (getState: () => SynthDesignerState, voiceIx: number, synthIx?: number) => ({
      type: 'UNGATE',
      voiceIx,
      synthIx,
      getState,
    }),
    subReducer: (state: SynthDesignerState, { voiceIx, synthIx, getState }) => {
      if (R.isNil(synthIx)) {
        state.synths.forEach(({ voices, gainADSRLength, fmSynth }, synthIx) => {
          fmSynth?.onUnGate(voiceIx);
          const targetVoice = voices[voiceIx];
          // We edit state directly w/o updating references because this is only needed internally
          const ungateTime = ctx.currentTime;
          targetVoice.lastGateOrUngateTime = ungateTime;
          const releaseLengthMs =
            (1 - targetVoice.gainADSRModule.envelope.release.pos) * gainADSRLength;

          setTimeout(
            () => {
              const state = getState();
              const targetSynth = state.synths[synthIx];
              if (!targetSynth) {
                return;
              }
              const { waveform, fmSynth } = targetSynth;
              const targetVoice = voices[voiceIx];
              if (targetVoice.lastGateOrUngateTime !== ungateTime) {
                // Voice has been re-gated before it finished playing last time; do not disconnect
                return;
              }

              targetVoice.outerGainNode.disconnect();

              // Optimization to avoid computing voices that aren't playing
              if (waveform === Waveform.FM && fmSynth) {
                fmSynth.setFrequency(voiceIx, 0);
              }
            },
            // We wait until the voice is done playing, accounting for the early-release phase and
            // adding a little bit extra leeway
            //
            // We will need to make this dynamic if we make the length of the early release period
            // user-configurable
            releaseLengthMs + (2_640 / 44_100) * 1000 + 60
          );

          // Trigger release of gain and filter ADSRs
          targetVoice.gainADSRModule.ungate();
          targetVoice.filterADSRModule.ungate(voiceIx);
        });
      } else {
        const targetSynth = getSynth(synthIx, state.synths);
        targetSynth.fmSynth?.onUnGate(voiceIx);
        const targetVoice = targetSynth.voices[voiceIx];
        // We edit state directly w/o updating references because this is only needed internally
        const ungateTime = ctx.currentTime;
        targetVoice.lastGateOrUngateTime = ungateTime;
        const releaseLengthMs =
          (1 - targetVoice.gainADSRModule.envelope.release.pos) * targetSynth.gainADSRLength;

        setTimeout(() => {
          const state = getState();
          const targetSynth = getSynth(synthIx, state.synths);
          if (!targetSynth) {
            return;
          }
          const targetVoice = targetSynth.voices[voiceIx];
          if (targetVoice.lastGateOrUngateTime !== ungateTime) {
            // Voice has been re-gated before it finished playing last time; do not disconnect
            return;
          }

          targetVoice.outerGainNode.disconnect();

          // Optimization to avoid computing voices that aren't playing
          if (targetSynth.waveform === Waveform.FM && targetSynth.fmSynth) {
            targetSynth.fmSynth.setFrequency(voiceIx, 0);
          }
        }, releaseLengthMs + 150);

        // Trigger release of gain and filter ADSRs
        targetVoice.gainADSRModule.ungate();
        targetVoice.filterADSRModule.ungate(voiceIx);
      }

      return state;
    },
  }),
  SET_UNISON: buildActionGroup({
    actionCreator: (synthIx: number, unison: number) => ({ type: 'SET_UNISON', synthIx, unison }),
    subReducer: (state: SynthDesignerState, { synthIx, unison }) => {
      const targetSynth = getSynth(synthIx, state.synths);

      if (unison <= 0 || parseInt(unison.toString(), 10) !== unison) {
        console.error(`Invalid unison value of ${unison} provided`);
        return state;
      }

      const newVoices = targetSynth.voices.map(voice => {
        while (voice.oscillators.length > unison) {
          const osc = voice.oscillators.pop()!;
          osc.stop();
          osc.disconnect();
        }

        while (voice.oscillators.length < unison) {
          const osc = new OscillatorNode(ctx);
          osc.frequency.value = voice.oscillators[0].frequency.value;
          osc.type = targetSynth.waveform === Waveform.FM ? Waveform.Sine : targetSynth.waveform;
          voice.oscillators.push(osc);
          targetSynth.detuneCSN.connect(osc.detune);
          osc.start();
          osc.connect(
            targetSynth.filterBypassed ? voice.outerGainNode : voice.filterNode.getInput()
          );
        }

        const newSynth = { ...voice, oscillators: [...voice.oscillators] };
        setUnisonSpread(state.synths[synthIx], targetSynth.unisonSpreadCents ?? 0);
        return newSynth;
      });

      return {
        ...state,
        synths: [
          ...state.synths.slice(0, synthIx),
          { ...targetSynth, voices: newVoices },
          ...state.synths.slice(synthIx + 1),
        ],
      };
    },
  }),
  SET_UNISON_SPREAD_CENTS: buildActionGroup({
    actionCreator: (synthIx: number, unisonSpreadCents: number) => ({
      type: 'SET_UNISON_SPREAD_CENTS',
      synthIx,
      unisonSpreadCents,
    }),
    subReducer: (state: SynthDesignerState, { synthIx, unisonSpreadCents }) => {
      setUnisonSpread(state.synths[synthIx], unisonSpreadCents);
      return setSynth(synthIx, { ...state.synths[synthIx], unisonSpreadCents }, state);
    },
  }),
  SET_DETUNE: buildActionGroup({
    actionCreator: (detune: number, synthIx?: number) => ({ type: 'SET_DETUNE', synthIx, detune }),
    subReducer: (state: SynthDesignerState, { synthIx, detune }) => {
      if (R.isNil(synthIx)) {
        return {
          ...state,
          synths: state.synths.map(synth => {
            synth.detuneCSN.offset.setValueAtTime(detune, ctx.currentTime);

            return { ...synth, detune };
          }),
        };
      }

      const targetSynth = getSynth(synthIx, state.synths);
      targetSynth.detuneCSN.offset.setValueAtTime(detune, ctx.currentTime);

      return setSynth(synthIx, { ...targetSynth, detune }, state);
    },
  }),
  SET_GAIN_ADSR: buildActionGroup({
    actionCreator: (envelope: ADSRValues, synthIx: number) => ({
      type: 'SET_GAIN_ADSR',
      envelope,
      synthIx,
    }),
    subReducer: (state: SynthDesignerState, { envelope, synthIx }) => {
      const targetSynth = getSynth(synthIx, state.synths);
      targetSynth.voices.forEach(voice => voice.gainADSRModule.setEnvelope(envelope));

      return setSynth(synthIx, { ...targetSynth, gainEnvelope: envelope }, state);
    },
  }),
  SET_FILTER_ADSR: buildActionGroup({
    actionCreator: (envelope: Adsr, synthIx: number) => ({
      type: 'SET_FILTER_ADSR',
      envelope,
      synthIx,
    }),
    subReducer: (state: SynthDesignerState, { envelope, synthIx }) => {
      const targetSynth = getSynth(synthIx, state.synths);
      targetSynth.voices.forEach(voice => voice.filterADSRModule.setState(envelope));

      return setSynth(synthIx, { ...targetSynth, filterEnvelope: envelope }, state);
    },
  }),
  SET_WAVY_JONES_INSTANCE: buildActionGroup({
    actionCreator: (instance: AnalyserNode) => ({ type: 'SET_WAVY_JONES_INSTANCE', instance }),
    subReducer: (state: SynthDesignerState, { instance }) => {
      if (state.spectrumNode) {
        instance.connect(state.spectrumNode);
      }

      return { ...state, wavyJonesInstance: instance };
    },
  }),
  SET_EFFECT_BYPASSED: buildActionGroup({
    actionCreator: (synthIx: number, effectIx: number, isBypassed = true) => ({
      type: 'SET_EFFECT_BYPASSED' as const,
      isBypassed,
      synthIx,
      effectIx,
    }),
    subReducer: (
      state: SynthDesignerState,
      {
        isBypassed,
        synthIx,
        effectIx,
      }: { type: 'SET_EFFECT_BYPASSED'; isBypassed: boolean; synthIx: number; effectIx: number }
    ): SynthDesignerState => {
      const { targetEffect } = getEffect(synthIx, effectIx, state.synths);
      // TODO: Actually bypass?
      return setEffect(
        synthIx,
        effectIx,
        targetEffect.map(targetEffect => ({ ...targetEffect, isBypassed })),
        state
      );
    },
  }),
  SET_EFFECT_WETNESS: buildActionGroup({
    actionCreator: (synthIx: number, effectIx: number, wetness: number) => ({
      type: 'SET_EFFECT_WETNESS',
      synthIx,
      effectIx,
      wetness,
    }),
    subReducer: (state: SynthDesignerState, { synthIx, effectIx, wetness }) => {
      const { targetEffect } = getEffect(synthIx, effectIx, state.synths);
      if (wetness < 0 || wetness > 1) {
        console.error(`Invalid wetness of ${wetness} provided`);
        return state;
      }

      // TODO: Use a CSN for effects?
      const newEffects = targetEffect.map(targetEffect => {
        targetEffect.effectGainNode.gain.setValueAtTime(wetness, ctx.currentTime);
        targetEffect.passthroughGainNode.gain.setValueAtTime(1 - wetness, ctx.currentTime);

        return { ...targetEffect, wetness };
      });

      return setEffect(synthIx, effectIx, newEffects, state);
    },
  }),
  SET_EFFECT_PARAM: buildActionGroup({
    actionCreator: (synthIx: number, effectIx: number, key: string, val: number) => ({
      type: 'SET_EFFECT_PARAM',
      synthIx,
      effectIx,
      key,
      val,
    }),
    subReducer: (state: SynthDesignerState, { synthIx, effectIx, key, val }) => {
      const { targetEffect } = getEffect(synthIx, effectIx, state.synths);
      targetEffect.forEach(targetEffect => targetEffect.effect.node.setParam(key, val));

      return setEffect(
        synthIx,
        effectIx,
        targetEffect.map(targetEffect => ({
          ...targetEffect,
          params: { ...targetEffect.params, [key]: val },
        })),
        state
      );
    },
  }),
  SET_FILTER_PARAM: buildActionGroup({
    actionCreator<K extends keyof FilterParams>(synthIx: number, key: K, val: FilterParams[K]) {
      return { type: 'SET_FILTER_PARAM', synthIx, key, val };
    },
    subReducer: (state: SynthDesignerState, { synthIx, key, val }) => {
      const targetSynth = getSynth(synthIx, state.synths);

      const newSynth = {
        ...targetSynth,
        filterParams: { ...targetSynth.filterParams, ...targetSynth.filterParams, [key]: val },
      };
      const newFilters = updateFilterNode(
        targetSynth.voices.map(R.prop('filterNode')),
        targetSynth.filterCSNs,
        key as keyof FilterParams,
        val
      );
      if (newFilters) {
        connectOscillators(false, targetSynth);
        newSynth.voices = newSynth.voices.map((voice, voiceIx) => ({
          ...voice,
          filterNode: newFilters[voiceIx],
        }));
        newSynth.voices.forEach(voice => voice.filterNode.getOutput().connect(voice.outerGainNode));
        connectOscillators(true, newSynth);
      }

      return setSynth(synthIx, newSynth, state);
    },
  }),
  SET_SYNTH_MASTER_GAIN: buildActionGroup({
    actionCreator: (synthIx: number, gain: number) => ({
      type: 'SET_SYNTH_MASTER_GAIN',
      synthIx,
      gain,
    }),
    subReducer: (state: SynthDesignerState, { synthIx, gain }) => {
      const targetSynth = getSynth(synthIx, state.synths);
      targetSynth.voices.forEach(voice => voice.gainADSRModule.setMaxValue(1 + gain));
      return setSynth(synthIx, { ...targetSynth, masterGain: gain }, state);
    },
  }),
  SET_SELECTED_EFFECT_TYPE: buildActionGroup({
    actionCreator: (synthIx: number, effectType: EffectType) => ({
      type: 'SET_SELECTED_EFFECT_TYPE',
      synthIx,
      effectType,
    }),
    subReducer: (state: SynthDesignerState, { synthIx, effectType }) => {
      const targetSynth = getSynth(synthIx, state.synths);
      return setSynth(synthIx, { ...targetSynth, selectedEffectType: effectType }, state);
    },
  }),
  SET_VOICE_STATE: buildActionGroup({
    actionCreator: (
      synthIx: number,
      preset: SynthVoicePreset | null,
      dispatch: (action: { type: 'CONNECT_FM_SYNTH'; synthIx: number }) => void
    ) => ({
      type: 'SET_VOICE_STATE',
      synthIx,
      preset,
      dispatch,
    }),
    subReducer: (state: SynthDesignerState, { synthIx, preset, dispatch }) => {
      synthIx = synthIx === -1 ? state.synths.length - 1 : synthIx;
      const oldSynthModule = state.synths[synthIx];
      if (!oldSynthModule) {
        console.error(
          `Tried to replace synth index ${synthIx} but only ${state.synths.length} exist`
        );
        return state;
      }

      const builtVoice: SynthModule = preset
        ? deserializeSynthModule(preset, dispatch, synthIx)
        : buildDefaultSynthModule(FilterType.Lowpass);

      return { ...state, synths: R.set(R.lensIndex(synthIx), builtVoice, state.synths) };
    },
  }),
  SET_SYNTH_DESIGNER_IS_HIDDEN: buildActionGroup({
    actionCreator: (isHidden: boolean) => ({ type: 'SET_SYNTH_DESIGNER_IS_HIDDEN', isHidden }),
    subReducer: (state: SynthDesignerState, { isHidden }) => ({ ...state, isHidden }),
  }),
  CONNECT_FM_SYNTH: buildActionGroup({
    actionCreator: (synthIx: number) => ({
      type: 'CONNECT_FM_SYNTH',
      synthIx,
    }),
    subReducer: (state: SynthDesignerState, { synthIx }) => {
      const targetSynth = getSynth(synthIx, state.synths);
      if (!targetSynth.fmSynth) {
        throw new UnreachableException("Initialized FM synth but it's not set now");
      }

      connectOscillators(false, targetSynth);
      connectOscillators(true, targetSynth);

      setTimeout(() => {
        const newConnectables = get_synth_designer_audio_connectables(
          `synthDesigner_${state.vcId}`
        );
        updateConnectables(state.vcId, newConnectables);
      });

      return state;
    },
  }),
  SET_PITCH_MULTIPLIER: buildActionGroup({
    actionCreator: (synthIx: number, pitchMultiplier: number) => ({
      type: 'SET_PITCH_MULTIPLIER',
      synthIx,
      pitchMultiplier,
    }),
    subReducer: (state: SynthDesignerState, { synthIx, pitchMultiplier }) => {
      const synth = getSynth(synthIx, state.synths);
      return setSynth(synthIx, { ...synth, pitchMultiplier }, state);
    },
  }),
  SET_SYNTH_PRESET: buildActionGroup({
    actionCreator: (
      preset: SynthPresetEntry,
      dispatch: (action: { type: 'CONNECT_FM_SYNTH'; synthIx: number }) => void
    ) => ({ type: 'SET_SYNTH_PRESET', preset, dispatch }),
    subReducer: (state: SynthDesignerState, { preset, dispatch }) => {
      if (state.synths.length !== 0) {
        throw new Error(
          'Expected that all synths would be removed before dispatching `SET_SYNTH_PRESET`'
        );
      }

      const synths = preset.body.voices.map((def, i) => deserializeSynthModule(def, dispatch, i));
      return { ...state, synths };
    },
  }),
  SET_FILTER_IS_BYPASSED: buildActionGroup({
    actionCreator: (synthIx: number, filterBypassed: boolean) => ({
      type: 'SET_FILTER_IS_BYPASSED',
      synthIx,
      filterBypassed,
    }),
    subReducer: (state: SynthDesignerState, { synthIx, filterBypassed }) => {
      const targetSynth = getSynth(synthIx, state.synths);
      if (targetSynth.filterBypassed === filterBypassed) {
        return state;
      }

      connectOscillators(false, targetSynth);
      const newSynth = { ...targetSynth, filterBypassed };
      connectOscillators(true, newSynth);

      return setSynth(synthIx, newSynth, state);
    },
  }),
  SET_GAIN_ADSR_LENGTH: buildActionGroup({
    actionCreator: (synthIx: number, lengthMs: number) => ({
      type: 'SET_GAIN_ADSR_LENGTH',
      synthIx,
      lengthMs,
    }),
    subReducer: (state: SynthDesignerState, { synthIx, lengthMs }) => {
      const targetSynth = getSynth(synthIx, state.synths);
      targetSynth.voices.forEach(voice => voice.gainADSRModule.setLengthMs(lengthMs));
      return setSynth(synthIx, { ...targetSynth, gainADSRLength: lengthMs }, state);
    },
  }),
  SET_GAIN_LOG_SCALE: buildActionGroup({
    actionCreator: (synthIx: number, logScale: boolean) => ({
      type: 'SET_GAIN_LOG_SCALE',
      synthIx,
      logScale,
    }),
    subReducer: (state: SynthDesignerState, { synthIx, logScale }) => {
      // Not currently implemented since ADSR1 doesn't support log scale
      return state;
    },
  }),
  SET_FILTER_ADSR_LENGTH: buildActionGroup({
    actionCreator: (synthIx: number, lengthMs: number) => ({
      type: 'SET_FILTER_ADSR_LENGTH',
      synthIx,
      lengthMs,
    }),
    subReducer: (state: SynthDesignerState, { synthIx, lengthMs }) => {
      const targetSynth = getSynth(synthIx, state.synths);
      targetSynth.voices.forEach(voice => voice.filterADSRModule.setLengthMs(lengthMs));
      return setSynth(synthIx, { ...targetSynth, filterADSRLength: lengthMs }, state);
    },
  }),
  SET_POLYSYNTH_CTX: buildActionGroup({
    actionCreator: (ctx: PolysynthContext) => ({ type: 'SET_POLYSYNTH_CTX', ctx }),
    subReducer: (state: SynthDesignerState, { ctx }) => ({ ...state, polysynthCtx: ctx }),
  }),
};

const buildSynthDesignerReduxInfra = (vcId: string) =>
  buildModule<SynthDesignerState, typeof actionGroups>(
    getInitialSynthDesignerState(true, vcId),
    actionGroups
  );

export default buildSynthDesignerReduxInfra;
