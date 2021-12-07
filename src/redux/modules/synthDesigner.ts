import * as R from 'ramda';
import { buildModule, buildActionGroup, buildStore } from 'jantix';
import { reducer as formReducer } from 'redux-form';
import type { Root as ReactDOMRoot } from 'react-dom';

import { ADSR2Module } from 'src/synthDesigner/ADSRModule';
import type { SynthPresetEntry, SynthVoicePreset } from 'src/redux/modules/presets';
import FMSynth, { Adsr, AdsrParams } from 'src/graphEditor/nodes/CustomAudio/FMSynth/FMSynth';
import { msToSamples, normalizeEnvelope, samplesToMs } from 'src/util';
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

export interface FilterParams {
  type: FilterType;
  frequency: number;
  Q?: number;
  gain: number;
  detune: number;
}

export interface Voice {
  // The node that is connected to whatever the synth module as a whole is connected to.  Its
  // source is the inner gain node.
  outerGainNode: GainNode;
  filterNode: AbstractFilterModule;
  filterADSRModule: ADSR2Module;
  lastGateOrUngateTime: number;
}

interface PolysynthContext {
  module: typeof import('src/polysynth');
  ctxPtr: number;
}

export enum FilterFrequencySource {
  CSNs,
  ADSR,
}

export interface SynthModule {
  filterBypassed: boolean;
  voices: Voice[];
  fmSynth: FMSynth;
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
      return new Array(filters.length)
        .fill(null)
        .map(() => buildAbstractFilterModule(ctx, val as any, csns));
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
  fmSynthConfig: synth.fmSynth?.serialize(),
  filter: synth.filterParams,
  masterGain: synth.masterGain,
  filterEnvelope: synth.filterEnvelope,
  filterADSRLength: synth.filterADSRLength,
  pitchMultiplier: synth.pitchMultiplier,
  filterBypassed: synth.filterBypassed,
});

const connectOscillators = (connect: boolean, synth: SynthModule) =>
  synth.voices.forEach((voice, voiceIx) => {
    const voiceDst = synth.filterBypassed ? voice.outerGainNode : voice.filterNode.getInput();

    const fmSynthAWPNode = synth.fmSynth.getAWPNode();

    if (!connect) {
      try {
        fmSynthAWPNode?.disconnect();
      } catch (_err) {
        // pass
      }
    } else {
      fmSynthAWPNode?.connect(voiceDst, voiceIx);
    }
  });

const connectFMSynth = (stateKey: string, synthIx: number) => {
  const vcId = stateKey.split('_')[1];
  const reduxInfra = getSynthDesignerReduxInfra(stateKey);
  if (!reduxInfra) {
    console.error('Failed to get synth designer redux infra for vcId=' + vcId);
    return;
  }

  const targetSynth = reduxInfra.getState().synthDesigner.synths[synthIx];
  if (!targetSynth) {
    console.error(
      `Failed to get synth at index=${synthIx} for vcId=${vcId} when connecting FM synth`
    );
    return;
  }

  connectOscillators(false, targetSynth);
  connectOscillators(true, targetSynth);

  setTimeout(() => {
    const newConnectables = get_synth_designer_audio_connectables(`synthDesigner_${vcId}`);
    updateConnectables(vcId, newConnectables);
  });
};

export const gateSynthDesigner = (
  state: SynthDesignerState,
  baseFrequency: number,
  voiceIx: number
) =>
  state.synths.forEach(synth => {
    synth.fmSynth?.onGate(voiceIx);
    const frequency = baseFrequency * synth.pitchMultiplier;

    const targetVoice = synth.voices[voiceIx];
    if (!state.wavyJonesInstance) {
      return;
    }

    // Trigger gain and filter ADSRs
    targetVoice.filterADSRModule.gate(voiceIx);
    // We edit state directly w/o updating references because this is only needed internally
    targetVoice.lastGateOrUngateTime = ctx.currentTime;

    synth.fmSynth.setFrequency(voiceIx, frequency);

    targetVoice.outerGainNode.connect(state.wavyJonesInstance);
  });

export const ungateSynthDesigner = (
  getState: () => { synthDesigner: SynthDesignerState },
  voiceIx: number
) =>
  getState().synthDesigner.synths.forEach(({ voices, fmSynth }, synthIx) => {
    fmSynth?.onUnGate(voiceIx);
    const targetVoice = voices[voiceIx];
    // We edit state directly w/o updating references because this is only needed internally
    const ungateTime = ctx.currentTime;
    targetVoice.lastGateOrUngateTime = ungateTime;
    const releaseLengthMs =
      (1 - fmSynth.gainEnvelope.releasePoint) * samplesToMs(fmSynth.gainEnvelope.lenSamples.value);

    setTimeout(
      () => {
        const state = getState().synthDesigner;
        const targetSynth = state.synths[synthIx];
        if (!targetSynth) {
          return;
        }
        const targetVoice = voices[voiceIx];
        if (targetVoice.lastGateOrUngateTime !== ungateTime) {
          // Voice has been re-gated before it finished playing last time; do not disconnect
          return;
        }

        targetVoice.outerGainNode.disconnect();

        // Optimization to avoid computing voices that aren't playing
        targetSynth.fmSynth.setFrequency(voiceIx, 0);
      },
      // We wait until the voice is done playing, accounting for the early-release phase and
      // adding a little bit extra leeway
      //
      // We will need to make this dynamic if we make the length of the early release period
      // user-configurable
      releaseLengthMs + (2_640 / 44_100) * 1000 + 60
    );

    // Trigger release of gain and filter ADSRs
    targetVoice.filterADSRModule.ungate(voiceIx);
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
  filterParams.type = filterParams.type ?? filterType;

  Object.entries(filterParams)
    .filter(([k, _v]) => k !== 'type')
    .forEach(([key, val]) =>
      updateFilterNode([filterNode], filterCSNs, key as keyof typeof filterParams, val)
    );

  return { filterParams, filterNode };
};

const buildDefaultSynthModule = (
  stateKey: string,
  filterType: FilterType,
  synthIx: number
): SynthModule => {
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
    filterBypassed: true,
    voices: new Array(VOICE_COUNT).fill(null).map((_, voiceIndex) => {
      const outerGainNode = new GainNode(ctx);
      outerGainNode.gain.setValueAtTime(1, ctx.currentTime);

      const { filterNode } = buildDefaultFilterModule(filterType, filterCSNs);
      // TODO: Connect ADSR once we can do so intelligently
      filterNode.getOutput().connect(outerGainNode);

      // We connect the ADSR modules to a dummy output in order to drive them for a while so that
      // they can initialize.
      //
      // If we don't do this, they will start off in an invalid state and, naturally, make
      // horrifically loud noises.
      filterADSRModule.getOutput().then(output => output.connect(dummyGain, voiceIndex));

      setTimeout(() => {
        filterADSRModule.getOutput().then(output => output.disconnect(dummyGain, voiceIndex));
        dummyGain.disconnect();
      }, 1000);

      return {
        outerGainNode,
        filterNode,
        filterADSRModule,
        lastGateOrUngateTime: 0,
      };
    }),
    fmSynth: new FMSynth(ctx, undefined, {
      onInitialized: () => connectFMSynth(stateKey, synthIx),
    }),
    filterParams,
    filterCSNs,
    filterFrequencySource: FilterFrequencySource.CSNs,
    masterGain,
    filterEnvelope: buildDefaultADSR2Envelope({ phaseIndex: 0 }),
    filterADSRLength: 1000,
    pitchMultiplier: 1,
  };

  return inst;
};

export const deserializeSynthModule = (
  {
    filter: filterParams,
    masterGain,
    gainEnvelope,
    gainADSRLength,
    filterEnvelope,
    filterADSRLength,
    pitchMultiplier,
    filterBypassed = true,
    fmSynthConfig,
  }: SynthVoicePreset,
  stateKey: string,
  synthIx: number
): SynthModule => {
  const base = buildDefaultSynthModule(stateKey, filterParams.type, synthIx);

  const voices = base.voices.map(voice => {
    voice.filterNode.getOutput().connect(voice.outerGainNode);
    Object.entries(filterParams)
      .filter(([k, _v]) => k !== 'type')
      .forEach(([key, val]: [keyof typeof filterParams, any]) =>
        updateFilterNode([voice.filterNode], base.filterCSNs, key, val)
      );

    if ((filterEnvelope as any).attack) {
      filterEnvelope = buildDefaultADSR2Envelope({ phaseIndex: 0 });
    }
    voice.filterADSRModule.setState(filterEnvelope as Adsr);
    voice.filterADSRModule.setLengthMs(filterADSRLength ?? 1000);
    // TODO: Connect filter ADSR module once we can do so intelligently

    return voice;
  });

  const synthModule = {
    ...base,
    filterBypassed,
    voices,
    fmSynth: new FMSynth(ctx, undefined, {
      ...(fmSynthConfig || {}),
      gainEnvelope: gainEnvelope
        ? { ...normalizeEnvelope(gainEnvelope), lenSamples: msToSamples(gainADSRLength ?? 1000) }
        : fmSynthConfig.gainEnvelope,
      onInitialized: () => connectFMSynth(stateKey, synthIx),
    }),
    masterGain,
    filterEnvelope: normalizeEnvelope(filterEnvelope),
    filterADSRLength: filterADSRLength ?? 1000,
    filterParams,
    pitchMultiplier: pitchMultiplier ?? 1,
  };
  connectOscillators(false, synthModule);
  connectOscillators(true, synthModule);

  return synthModule;
};

export const getInitialSynthDesignerState = (vcId: string): SynthDesignerState => ({
  synths: [buildDefaultSynthModule(`synthDesigner_${vcId}`, FilterType.Lowpass, 0)],
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

const setSynth = (
  synthIx: number,
  synth: SynthModule,
  state: SynthDesignerState
): SynthDesignerState => ({
  ...state,
  synths: R.set(R.lensIndex(synthIx), synth, state.synths),
});

const actionGroups = {
  SET_STATE: buildActionGroup({
    actionCreator: (state: SynthDesignerState) => ({ type: 'SET_STATE', state }),
    subReducer: (_state: SynthDesignerState, { state }) => state,
  }),
  ADD_SYNTH_MODULE: buildActionGroup({
    actionCreator: () => ({ type: 'ADD_SYNTH_MODULE' }),
    subReducer: (state: SynthDesignerState) => {
      const newModule = buildDefaultSynthModule(
        `synthDesigner_${state.vcId}`,
        FilterType.Lowpass,
        state.synths.length
      );

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
  // TODO: Should not be a Redux action
  SET_GAIN_ADSR: buildActionGroup({
    actionCreator: (envelope: AdsrParams, synthIx: number) => ({
      type: 'SET_GAIN_ADSR',
      envelope,
      synthIx,
    }),
    subReducer: (state: SynthDesignerState, { envelope, synthIx }) => {
      const targetSynth = getSynth(synthIx, state.synths);
      targetSynth.fmSynth.handleAdsrChange(-1, envelope);
      return state;
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
      (instance as any).isPaused = state.isHidden;

      return { ...state, wavyJonesInstance: instance };
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
      // TODO
      return state;
    },
  }),
  SET_VOICE_STATE: buildActionGroup({
    actionCreator: (synthIx: number, preset: SynthVoicePreset | null) => ({
      type: 'SET_VOICE_STATE',
      synthIx,
      preset,
    }),
    subReducer: (state: SynthDesignerState, { synthIx, preset }) => {
      synthIx = synthIx === -1 ? state.synths.length - 1 : synthIx;
      const oldSynthModule = state.synths[synthIx];
      if (!oldSynthModule) {
        console.error(
          `Tried to replace synth index ${synthIx} but only ${state.synths.length} exist`
        );
        return state;
      }

      const stateKey = `synthDesigner_${state.vcId}`;
      const builtVoice: SynthModule = preset
        ? deserializeSynthModule(preset, stateKey, synthIx)
        : buildDefaultSynthModule(stateKey, FilterType.Lowpass, synthIx);

      return { ...state, synths: R.set(R.lensIndex(synthIx), builtVoice, state.synths) };
    },
  }),
  SET_SYNTH_DESIGNER_IS_HIDDEN: buildActionGroup({
    actionCreator: (isHidden: boolean) => ({ type: 'SET_SYNTH_DESIGNER_IS_HIDDEN', isHidden }),
    subReducer: (state: SynthDesignerState, { isHidden }) => {
      if (state.wavyJonesInstance) {
        (state.wavyJonesInstance as any).isPaused = isHidden;
      }

      return { ...state, isHidden };
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
    actionCreator: (preset: SynthPresetEntry) => ({ type: 'SET_SYNTH_PRESET', preset }),
    subReducer: (state: SynthDesignerState, { preset }) => {
      if (state.synths.length !== 0) {
        throw new Error(
          'Expected that all synths would be removed before dispatching `SET_SYNTH_PRESET`'
        );
      }

      const stateKey = `synthDesigner_${state.vcId}`;
      const synths = preset.body.voices.map((def, i) => deserializeSynthModule(def, stateKey, i));
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
  // TODO: Does not need to be a Redux action
  SET_GAIN_ADSR_LENGTH: buildActionGroup({
    actionCreator: (synthIx: number, lengthMs: number) => ({
      type: 'SET_GAIN_ADSR_LENGTH',
      synthIx,
      lengthMs,
    }),
    subReducer: (state: SynthDesignerState, { synthIx, lengthMs }) => {
      const targetSynth = getSynth(synthIx, state.synths);
      targetSynth.fmSynth.handleAdsrChange(-1, {
        ...targetSynth.fmSynth.gainEnvelope,
        lenSamples: { type: 'constant', value: msToSamples(lengthMs) },
      });
      return state;
    },
  }),
  // TODO: Does not need to be a Redux action
  SET_GAIN_LOG_SCALE: buildActionGroup({
    actionCreator: (synthIx: number, logScale: boolean) => ({
      type: 'SET_GAIN_LOG_SCALE',
      synthIx,
      logScale,
    }),
    subReducer: (state: SynthDesignerState, { synthIx, logScale }) => {
      const targetSynth = getSynth(synthIx, state.synths);
      targetSynth.fmSynth.handleAdsrChange(-1, {
        ...targetSynth.fmSynth.gainEnvelope,
        logScale,
      });
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

/**
 * Global map of state key to Redux infrastructure
 */
export const SynthDesignerStateByStateKey: Map<
  string,
  ReturnType<typeof buildSynthDesignerReduxInfra> & { reactRoot: ReactDOMRoot | 'NOT_LOADED' }
> = new Map();

export const getSynthDesignerReduxInfra = (stateKey: string) => {
  const reduxInfra = SynthDesignerStateByStateKey.get(stateKey);
  if (!reduxInfra) {
    throw new Error(`No Redux state entry for state key "${stateKey}"`);
  }

  return reduxInfra;
};

const buildSynthDesignerReduxInfra = (vcId: string) => {
  const mod = buildModule<SynthDesignerState, typeof actionGroups>(
    getInitialSynthDesignerState(vcId),
    actionGroups
  );
  const modules = {
    synthDesigner: mod,
  };

  return buildStore<typeof modules>(modules, undefined, { form: formReducer });
};

export default buildSynthDesignerReduxInfra;
