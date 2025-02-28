import { filterNils, UnreachableException } from 'ameo-utils';
import * as R from 'ramda';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ControlPanel from 'react-control-panel';
import { createRoot } from 'react-dom/client';

import './fmDemo.scss';
import { mkControlPanelADSR2WithSize } from 'src/controls/adsr2/ControlPanelADSR2';
import FilterConfig, { FilterContainer } from 'src/fmDemo/FilterConfig';
import { Presets, type SerializedFMSynthDemoState } from 'src/fmDemo/presets';
import { ConnectedFMSynthUI } from 'src/fmSynth/FMSynthUI';
import FMSynth, {
  AdsrLengthMode,
  type Adsr,
} from 'src/graphEditor/nodes/CustomAudio/FMSynth/FMSynth';
import 'src/index.scss';
import { MIDIInput } from 'src/midiKeyboard/midiInput';
import { MidiKeyboard } from 'src/midiKeyboard/MidiKeyboard';
import BrowserNotSupported from 'src/misc/BrowserNotSupported';
import { MIDINode } from 'src/patchNetwork/midiNode';
import { useWindowSize } from 'src/reactUtils';
import type { FilterParams } from 'src/redux/modules/synthDesigner';
import { getSentry } from 'src/sentry';
import { ADSR2Module } from 'src/synthDesigner/ADSRModule';
import { FilterType, getDefaultFilterParams } from 'src/synthDesigner/filterHelpers';
import { msToSamples, normalizeEnvelope, samplesToMs } from 'src/util';
import { SpectrumVisualization } from 'src/visualizations/spectrum';

const VOICE_COUNT = 10;
const SAMPLE_RATE = 44_100;

const buildDefaultGainADSR = (): Adsr => ({
  steps: [
    { x: 0, y: 0, ramper: { type: 'exponential', exponent: 0.5 } },
    { x: 0.005, y: 0.8, ramper: { type: 'exponential', exponent: 0.5 } },
    { x: 0.7, y: 0.8, ramper: { type: 'exponential', exponent: 0.5 } },
    { x: 1, y: 0, ramper: { type: 'exponential', exponent: 0.5 } },
  ],
  lenSamples: SAMPLE_RATE,
  loopPoint: null,
  releasePoint: 0.7,
  audioThreadData: { phaseIndex: 255 },
});

const buildDefaultFilterEnvelope = (): Adsr => ({
  steps: [
    { x: 0, y: 0.8, ramper: { type: 'exponential', exponent: 0.5 } },
    { x: 0.04, y: 0.5, ramper: { type: 'exponential', exponent: 0.5 } },
    { x: 1, y: 0.5, ramper: { type: 'exponential', exponent: 0.5 } },
  ],
  lenSamples: SAMPLE_RATE,
  loopPoint: null,
  releasePoint: 0.7,
  audioThreadData: { phaseIndex: 0, debugName: '`buildDefaultFilterEnvelope`' },
});

const GlobalState: {
  octaveOffset: number;
  globalVolume: number;
  gainEnvelope: Adsr;
  filterParams: FilterParams;
  filterEnvelope: Adsr;
  filterBypassed: boolean;
  filterADSREnabled: boolean;
  selectedMIDIInputName?: string | undefined;
  lastLoadedPreset?: string | undefined;
} = {
  octaveOffset: 1,
  globalVolume: 0.2,
  gainEnvelope: buildDefaultGainADSR(),
  filterParams: getDefaultFilterParams(FilterType.Lowpass),
  filterEnvelope: buildDefaultFilterEnvelope(),
  filterBypassed: false,
  filterADSREnabled: true,
  selectedMIDIInputName: undefined,
  lastLoadedPreset: undefined,
};

const root = createRoot(document.getElementById('root')!);

const environmentIsValid =
  typeof AudioWorkletNode !== 'undefined' && typeof ConstantSourceNode !== 'undefined';
if (!environmentIsValid) {
  getSentry()?.captureException(
    new Error('Browser does not support `AudioWorkletNode`; displaying not supported message')
  );
  root.render(
    <div style={{ width: '100vw', height: '100vh', display: 'flex' }}>
      <BrowserNotSupported />
    </div>
  );
}

const ctx = new AudioContext();
const mainGain = new GainNode(ctx);
mainGain.gain.value = 0.1;
const filters = new Array(VOICE_COUNT).fill(null).map(() => {
  const filter = new FilterContainer(ctx, GlobalState.filterParams);
  filter.getOutput().connect(mainGain);
  return filter;
});

// Disable context menu on mobile that can be caused by long holds on keys
if (window.screen.width < 1000) {
  window.oncontextmenu = function (event) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    return false;
  };
}

const analyzerNode = new AnalyserNode(ctx);
mainGain.connect(analyzerNode);
// We connect it but pass through no audio, just keep it driven as a part of the
// audio graph.
const muter = new GainNode(ctx);
muter.gain.value = 0;
muter.connect(ctx.destination);

// Web browsers like to disable audio contexts when they first exist to prevent auto-play video/audio ads.
//
// We explicitly re-enable it whenever the user does something on the page.
document.addEventListener('keydown', () => ctx.resume(), { once: true });
document.addEventListener('mousedown', () => ctx.resume(), { once: true });
document.addEventListener('touchstart', () => ctx.resume(), { once: true });
document.addEventListener('touchend', () => ctx.resume(), { once: true });

const sentryRecord = (msg: string, extra: Record<string, any> = {}) => {
  const sentry = getSentry();
  if (!sentry) {
    return;
  }
  sentry.captureMessage(msg, { tags: { fmSynthDemo: true }, extra });
};

getSentry()?.setContext('fmSynthDemo', { fmSynthDemo: true });

// Add a limiter in between the main output and the destination to avoid super loud noises
// and extra volume caused by combining multiple voices
const limiter = new DynamicsCompressorNode(ctx);
limiter.connect(ctx.destination);

mainGain.connect(limiter);

const serializeState = () => {
  const serialized: SerializedFMSynthDemoState = {
    synth: synth.serialize(),
    octaveOffset: GlobalState.octaveOffset,
    globalVolume: GlobalState.globalVolume,
    gainEnvelope: adsrs.serialize(),
    filterParams: GlobalState.filterParams,
    filterEnvelope: filterAdsrs.serialize(),
    filterBypassed: GlobalState.filterBypassed,
    filterADSREnabled: GlobalState.filterADSREnabled,
    selectedMIDIInputName: GlobalState.selectedMIDIInputName,
    lastLoadedPreset: GlobalState.lastLoadedPreset,
  };
  return JSON.stringify(serialized);
};

window.onbeforeunload = () => {
  if (localStorage) {
    localStorage.fmSynthDemoState = serializeState();
  }
};

const LastGateTimeByVoice = new Array(10).fill(0);

let serialized: SerializedFMSynthDemoState | null = null;
try {
  if (localStorage?.fmSynthDemoState) {
    serialized = JSON.parse(localStorage.fmSynthDemoState);
  } else {
    serialized = Presets['pluck'];
    GlobalState.lastLoadedPreset = 'pluck';
  }
} catch (err) {
  getSentry()?.captureException(err, {
    extra: { localStorage__fmSynthDemoState: localStorage?.fmSynthDemoState },
  });
  console.error('Error deserializing fm synth');
  serialized = Presets['pluck'];
  GlobalState.lastLoadedPreset = 'pluck';
}
if (!R.isNil(serialized?.globalVolume)) {
  console.log('Setting global volume', serialized!.globalVolume);
  mainGain.gain.value = serialized!.globalVolume;
  GlobalState.globalVolume = serialized!.globalVolume;
}
if (!R.isNil(serialized?.octaveOffset)) {
  GlobalState.octaveOffset = serialized!.octaveOffset;
}
if (!R.isNil(serialized?.filterBypassed)) {
  GlobalState.filterBypassed = serialized!.filterBypassed;
}
GlobalState.filterADSREnabled = serialized!.filterADSREnabled ?? true;
GlobalState.selectedMIDIInputName = serialized!.selectedMIDIInputName;
GlobalState.lastLoadedPreset = serialized!.lastLoadedPreset;
if (serialized!.gainEnvelope) {
  GlobalState.gainEnvelope = normalizeEnvelope(serialized!.gainEnvelope);
}

const voiceGains = new Array(VOICE_COUNT).fill(null).map((_i, voiceIx) => {
  const gain = new GainNode(ctx);
  gain.gain.value = 0;
  const filterBypassed = serialized?.filterBypassed ?? false;
  if (filterBypassed) {
    gain.connect(mainGain);
  } else {
    gain.connect(filters[voiceIx].getInput());
  }
  return gain;
});
const adsrs = (() => {
  const base = GlobalState.gainEnvelope;
  const adsr = new ADSR2Module(
    ctx,
    {
      minValue: 0,
      maxValue: 1,
      length: base.lenSamples,
      lengthMode: AdsrLengthMode.Samples,
      loopPoint: base.loopPoint,
      releaseStartPhase: base.releasePoint,
      steps: base.steps,
    },
    VOICE_COUNT,
    base.audioThreadData
  );

  adsr.getOutput().then(adsrOutput => {
    voiceGains.forEach((voiceGain, i) => {
      adsrOutput.connect(voiceGain.gain, i);
    });
  });
  return adsr;
})();

const filterAdsrs = (() => {
  const base = GlobalState.filterEnvelope;
  GlobalState.filterEnvelope = base;
  const adsr = new ADSR2Module(
    ctx,
    {
      minValue: 80,
      maxValue: 44_100 / 2,
      length: base.lenSamples,
      lengthMode: AdsrLengthMode.Samples,
      loopPoint: base.loopPoint,
      releaseStartPhase: base.releasePoint,
      steps: base.steps,
    },
    VOICE_COUNT,
    base.audioThreadData
  );

  adsr.getOutput().then(adsrOutput => {
    filters.forEach((filter, i) => {
      adsrOutput.connect(filter.csns.frequency, i);
      // Filter is overridden if ADSR is disabled, meaning that the frequency slider from the UI
      // controls the fliter's frequency completely
      filter.csns.frequency.setIsOverridden(!GlobalState.filterADSREnabled);
    });
  });

  return adsr;
})();

if (!R.isNil(serialized?.filterParams)) {
  GlobalState.filterParams = serialized!.filterParams;
  filters.forEach(filter => filter.setAll(GlobalState.filterParams));
}

const baseTheme = {
  background1: 'rgb(35,35,35)',
  background2: 'rgb(54,54,54)',
  background2hover: 'rgb(58,58,58)',
  foreground1: 'rgb(112,112,112)',
  text1: 'rgb(235,235,235)',
  text2: 'rgb(161,161,161)',
};

const midiInputNode = new MIDINode();
const midiInput = new MIDIInput(ctx, midiInputNode, GlobalState.selectedMIDIInputName);
const midiOutput = new MIDINode(() => ({
  enableRxAudioThreadScheduling: { mailboxIDs: ['fm-synth-demo-fm-synth'] },
  onAttack: (_note, _velocity) => {
    throw new UnreachableException();
  },
  onRelease: (_note, _velocity) => {
    throw new UnreachableException();
  },
  onClearAll: () => {
    // no-op; this will never get sent directly from user MIDI devices and only exists
    // for internal web-synth use cases that aren't part of this demo
  },
  onPitchBend: () => {
    // not implemented
  },
}));
midiInputNode.connect(midiOutput);

const synth = new FMSynth(ctx, undefined, {
  ...(serialized?.synth ?? {}),
  audioThreadMIDIEventMailboxID: 'fm-synth-demo-fm-synth',
  midiNode: midiInputNode,
  onInitialized: () => {
    const awpNode = synth.getAWPNode()!;
    voiceGains.forEach((voiceGain, voiceIx) => awpNode.connect(voiceGain, voiceIx));

    const onGate = (_midiNumber: number, voiceIx: number) => {
      adsrs.gate(voiceIx);
      filterAdsrs.gate(voiceIx);
      LastGateTimeByVoice[voiceIx] = ctx.currentTime;
    };

    const onUngate = (_midiNumber: number, voiceIx: number) => {
      adsrs.ungate(voiceIx);
      filterAdsrs.ungate(voiceIx);

      // We wait until the voice is done playing, accounting for the early-release phase and
      // adding a little bit extra leeway
      //
      // We will need to make this dynamic if we make the length of the early release period
      // user-configurable
      const releaseLengthMs =
        (1 - adsrs.getReleaseStartPhase()) * adsrs.getLengthMs() + (2_640 / 44_100) * 1000 + 60;

      const expectedLastGateTime = LastGateTimeByVoice[voiceIx];
      setTimeout(() => {
        // If the voice has been re-gated since releasing, don't disconnect
        if (LastGateTimeByVoice[voiceIx] !== expectedLastGateTime) {
          return;
        }

        synth.clearOutputBuffer(voiceIx);
      }, releaseLengthMs);
    };

    synth.registerGateUngateCallbacks(onGate, onUngate);
  },
});

const playNote = (midiNumber: number) => {
  midiInputNode.onAttack(midiNumber, 255);
};

const releaseNote = (midiNumber: number) => {
  midiInputNode.onRelease(midiNumber, 255);
};

const MainControlPanel: React.FC = ({}) => {
  const [mainControlPanelState, setMainControlPanelState] = useState({
    'MAIN VOLUME': GlobalState.globalVolume,
    'volume envelope length ms': samplesToMs(GlobalState.gainEnvelope.lenSamples),
    'volume envelope': {
      ...GlobalState.gainEnvelope,
      outputRange: [0, 1],
    },
  });

  const SizedControlPanelADSR2 = useMemo(
    () => mkControlPanelADSR2WithSize(360, 200, undefined, 'fmSynthDemoVolumeEnvelope'),
    []
  );
  const settings = useMemo(
    () =>
      filterNils([
        {
          type: 'range',
          label: 'MAIN VOLUME',
          min: 0,
          max: 1,
        },
        window.screen.width < 1000
          ? null
          : {
              type: 'range',
              label: 'volume envelope length ms',
              min: 10,
              max: 10_000,
            },
        window.screen.width < 1000
          ? null
          : {
              type: 'custom',
              label: 'volume envelope',
              Comp: SizedControlPanelADSR2,
            },
      ]),
    [SizedControlPanelADSR2]
  );

  return (
    <ControlPanel
      style={{ width: window.screen.width < 1000 ? '100%' : 379 }}
      settings={settings}
      state={mainControlPanelState}
      onChange={(key: string, val: any) => {
        switch (key) {
          case 'MAIN VOLUME': {
            GlobalState.globalVolume = val;
            mainGain.gain.value = val;
            setMainControlPanelState({ ...mainControlPanelState, 'MAIN VOLUME': val });
            break;
          }
          case 'volume envelope': {
            adsrs.setState({
              ...val,
              lenSamples: msToSamples(adsrs.getLengthMs()),
            });
            setMainControlPanelState({
              ...mainControlPanelState,
              'volume envelope': {
                ...val,
                lenSamples: msToSamples(adsrs.getLengthMs()),
              },
            });
            break;
          }
          case 'volume envelope length ms': {
            adsrs.setLengthMs(val);
            setMainControlPanelState({
              ...mainControlPanelState,
              'volume envelope': {
                ...mainControlPanelState['volume envelope'],
                lenSamples: msToSamples(adsrs.getLengthMs()),
              },
              'volume envelope length ms': val,
            });
            break;
          }
          default: {
            console.error('Unhandled key: ' + key);
          }
        }
      }}
    />
  );
};

const bypassFilter = () => {
  voiceGains.forEach((node, voiceIx) => {
    node.disconnect(filters[voiceIx].getInput());
    node.connect(mainGain);
  });
};

const unBypassFilter = () => {
  voiceGains.forEach((node, voiceIx) => {
    node.disconnect(mainGain);
    node.connect(filters[voiceIx].getInput());
  });
};

const PresetsControlPanel: React.FC<{
  setOctaveOffset: (newOctaveOffset: number) => void;
  reRenderAll: () => void;
}> = ({ setOctaveOffset, reRenderAll }) => {
  const isLoadingPreset = useRef(false);
  const loadPreset = useCallback(
    (presetName: string) => {
      if (isLoadingPreset.current) {
        return;
      }

      GlobalState.lastLoadedPreset = presetName;
      const preset = R.clone(Presets[presetName]);
      serialized = preset;
      synth.deserialize(preset.synth);

      // Gain ADSRs
      const gainEnvelope: Adsr = {
        ...normalizeEnvelope(preset.gainEnvelope),
        audioThreadData: GlobalState.gainEnvelope.audioThreadData,
      };
      adsrs.setState(gainEnvelope);
      adsrs.setLength(AdsrLengthMode.Samples, gainEnvelope.lenSamples);
      GlobalState.gainEnvelope = gainEnvelope;
      // Filter ADSRs
      filterAdsrs.setState(normalizeEnvelope(preset.filterEnvelope));
      // Octave offset
      setOctaveOffset(preset.octaveOffset);
      GlobalState.octaveOffset = preset.octaveOffset;
      // Filters
      const filterEnvelope = {
        ...normalizeEnvelope(preset.filterEnvelope),
        audioThreadData: GlobalState.filterEnvelope.audioThreadData,
      };
      GlobalState.filterEnvelope = filterEnvelope;
      filterAdsrs.setState(filterEnvelope);
      GlobalState.filterParams = preset.filterParams;
      filters.forEach(filter => filter.setAll(GlobalState.filterParams));
      if (preset.filterBypassed !== GlobalState.filterBypassed) {
        if (preset.filterBypassed) {
          bypassFilter();
        } else {
          unBypassFilter();
        }
      }
      GlobalState.filterBypassed = preset.filterBypassed;
      if (GlobalState.filterADSREnabled !== (preset.filterADSREnabled ?? false)) {
        filters.forEach(filter => filter.csns.frequency.setIsOverridden(!preset.filterADSREnabled));
      }
      GlobalState.filterADSREnabled = preset.filterADSREnabled ?? false;

      // Disconnect main output to avoid any horrific artifacts while we're switching
      mainGain.disconnect(limiter);

      // FM synth ADSRs
      preset.synth.adsrs.forEach((adsr, adsrIx) => synth.handleAdsrChange(adsrIx, adsr));
      // FM synth modulation matrix
      preset.synth.modulationMatrix.forEach((row, srcOperatorIx) => {
        row.forEach((modIx, dstOperatorIx) => {
          synth.handleModulationIndexChange(srcOperatorIx, dstOperatorIx, modIx);
        });
      });
      // FM synth output weights
      preset.synth.outputWeights.forEach((outputWeight, operatorIx) =>
        synth.handleOutputWeightChange(operatorIx, outputWeight)
      );
      // FM synth operator configs
      preset.synth.operatorConfigs.forEach((config, opIx) =>
        synth.handleOperatorConfigChange(opIx, config)
      );
      // FM synth operator effects
      preset.synth.operatorEffects.forEach((effectsForOp, opIx) => {
        // Reverse order so that they hopefully get removed in descending order
        [...effectsForOp].reverse().forEach((effect, effectIx) => {
          synth.setEffect(opIx, 15 - effectIx, effect);
        });
      });
      // FM synth main effects
      [...preset.synth.mainEffectChain]
        // Reverse order so that they hopefully get removed in descending order
        .reverse()
        .forEach((effect, effectIx) => synth.setEffect(null, 15 - effectIx, effect));
      // FM synth selected UI
      synth.selectedUI = preset.synth.selectedUI;
      // FM synth detune
      synth.handleDetuneChange(preset.synth.detune);

      // Clear all UI and trigger it to re-initialize internal state from scratch
      reRenderAll();

      setTimeout(() => {
        mainGain.connect(limiter);
        isLoadingPreset.current = false;
      }, 200);
    },
    [reRenderAll, setOctaveOffset]
  );
  const controlPanelCtx = useRef<any>(null);

  const settings = useMemo(
    () =>
      filterNils([
        {
          type: 'select',
          label: 'select preset',
          options: Object.keys(Presets),
          initial: GlobalState.lastLoadedPreset ?? 'pluck',
        },
        {
          type: 'button',
          label: 'load preset',
          action: () => {
            if (!controlPanelCtx) {
              console.error('Tried to load preset, but control panel context not ready');
              return;
            }

            const presetName = controlPanelCtx.current['select preset'];
            sentryRecord('Load preset', { presetName });
            loadPreset(presetName);
          },
        },
        window.screen.width < 1000
          ? null
          : {
              type: 'button',
              label: 'copy preset to clipboard',
              action: async () => {
                const serialized = serializeState();
                sentryRecord('Copy preset to keyboard', { serialized });
                try {
                  navigator.clipboard.writeText(serialized);
                  alert('Successfully copied to clipboard');
                } catch (err) {
                  alert('Error copying text to clipboard: ' + err);
                }
              },
            },
      ]),
    [loadPreset]
  );

  return (
    <ControlPanel
      title='choose preset'
      contextCb={(ctx: any) => {
        controlPanelCtx.current = ctx;
      }}
      style={{ width: window.screen.width < 1000 ? '100%' : 379 }}
      settings={settings}
      theme={{
        ...baseTheme,
        background1: 'rgb(14 149 102 / 80%)',
        text1: 'rgb(255 255 255)',
      }}
    />
  );
};

const MIDIInputControlPanel: React.FC = () => {
  const [availableMIDIInputs, setAvailableMIDIInputs] = useState<string[]>([]);
  const [selectedMIDIInputName, setSelectedMIDIInputNameInner] = useState<string>(
    GlobalState.selectedMIDIInputName ?? ''
  );
  const setSelectedMIDIInputName = (newMIDIInputName: string) => {
    GlobalState.selectedMIDIInputName = newMIDIInputName ? newMIDIInputName : undefined;
    setSelectedMIDIInputNameInner(newMIDIInputName);
    midiInput.handleSelectedInputName(newMIDIInputName ? newMIDIInputName : undefined);
  };

  useEffect(() => {
    midiInput.getMidiInputNames().then(availableMIDIInputNames => {
      setAvailableMIDIInputs(['', ...availableMIDIInputNames]);
      if (
        GlobalState.selectedMIDIInputName &&
        availableMIDIInputNames.includes(GlobalState.selectedMIDIInputName)
      ) {
        setSelectedMIDIInputName(GlobalState.selectedMIDIInputName);
      }
    });
  }, []);

  const settings = useMemo(
    () => [
      { label: 'midi device', type: 'select', options: availableMIDIInputs },
      {
        label: 'refresh midi device list',
        type: 'button',
        action: () =>
          midiInput.getMidiInputNames().then(availableMIDIInputNames => {
            sentryRecord('Refreshed FM synth demo MIDI device list', { availableMIDIInputNames });
            setAvailableMIDIInputs(['', ...availableMIDIInputNames]);
          }),
      },
    ],
    [availableMIDIInputs]
  );
  const state = useMemo(() => ({ 'midi device': selectedMIDIInputName }), [selectedMIDIInputName]);

  return (
    <ControlPanel
      settings={settings}
      style={{ width: window.screen.width < 1000 ? '100%' : 379 }}
      state={state}
      onChange={(key: string, val: any) => {
        switch (key) {
          case 'midi device': {
            sentryRecord('Selected MIDI device', { midiInputName: val });
            setSelectedMIDIInputName(val);
            break;
          }
          default: {
            console.error('Unhandled key in MIDI input control panel: ', key);
          }
        }
      }}
    />
  );
};

const FMSynthDemo: React.FC = () => {
  const [octaveOffset, setOctaveOffsetInner] = useState(serialized?.octaveOffset ?? 1);
  const setOctaveOffset = (newOctaveOffset: number) => {
    GlobalState.octaveOffset = newOctaveOffset;
    setOctaveOffsetInner(newOctaveOffset);
  };
  const [renderUI, setRenderUI] = useState(true);
  const [showViz, setShowViz] = useState(false);
  const reRenderAll = () => setRenderUI(false);
  useEffect(() => {
    if (!renderUI) {
      setRenderUI(true);
    }
  }, [renderUI]);

  const windowSize = useWindowSize();
  // subtract the keyboard's height
  const height = windowSize.height - 228;

  if (!renderUI) {
    return null;
  }

  if (window.screen.width < 1000) {
    return (
      <>
        <div className='fm-synth-main-control-panel'>
          <MainControlPanel />
          <PresetsControlPanel setOctaveOffset={setOctaveOffset} reRenderAll={reRenderAll} />
        </div>

        <div className='fm-synth-demo-mobile-text'>
          <p>
            This is a trimmed-down version for mobile; visit the site on desktop for the full
            experience!{' '}
            {window.screen.width < window.screen.height
              ? 'Try turning your phone sideways as well.'
              : null}
          </p>
        </div>

        <div className='fm-synth-mobile-links'>
          <a href='/blog/fm-synth-rust-wasm-simd/'>Blog post</a>
          <br />
          <a href='/docs/fm-synth'>Docs</a>
          <br />
          <a href='https://www.youtube.com/watch?v=N4mZn9ZczDM'>Demo video + walkthrough</a>
        </div>

        <div className='midi-keyboard-wrapper' style={{ bottom: 0, position: 'absolute' }}>
          <MidiKeyboard
            octaveOffset={octaveOffset}
            onOctaveOffsetChange={setOctaveOffset}
            onAttack={midiNumber => playNote(midiNumber)}
            onRelease={midiNumber => releaseNote(midiNumber)}
            style={{ height: 180 }}
          />
        </div>
      </>
    );
  }

  return (
    <div className='fm-synth-demo'>
      <div className='fm-synth-demo-controls' style={{ height }}>
        <div className='fm-synth-main-control-panel'>
          <MainControlPanel />
          <PresetsControlPanel setOctaveOffset={setOctaveOffset} reRenderAll={reRenderAll} />
          <MIDIInputControlPanel />
          <ControlPanel
            settings={[
              {
                type: 'button',
                label: showViz ? 'hide spectrogram' : 'show spectrogram',
                action: () => {
                  sentryRecord('toggle fm synth demo visualization', { wasVisible: showViz });
                  setShowViz(!showViz);
                },
              },
            ]}
            style={{ width: 379 }}
          />
        </div>

        {showViz ? (
          <SpectrumVisualization
            paused={false}
            analyzerNode={analyzerNode}
            initialConf={{ color_fn: 2, scaler_fn: 0 }}
            height={800}
          />
        ) : (
          <>
            <ConnectedFMSynthUI
              synth={synth}
              getFMSynthOutput={async () => mainGain}
              midiNode={midiInputNode}
              synthID='demo'
              vcId={undefined}
              isHidden={false}
            />
            <FilterConfig
              filters={filters}
              adsrs={filterAdsrs}
              initialState={{
                params: GlobalState.filterParams,
                envelope: normalizeEnvelope(GlobalState.filterEnvelope),
                bypass: GlobalState.filterBypassed,
                enableADSR: GlobalState.filterADSREnabled,
              }}
              onChange={(
                params: FilterParams,
                envelope: Adsr,
                bypass: boolean,
                enableADSR: boolean
              ) => {
                GlobalState.filterParams = params;
                GlobalState.filterEnvelope = envelope;
                if (GlobalState.filterADSREnabled !== enableADSR) {
                  filters.forEach(filter => filter.csns.frequency.setIsOverridden(!enableADSR));
                }
                GlobalState.filterADSREnabled = enableADSR;

                if (bypass && !GlobalState.filterBypassed) {
                  bypassFilter();
                } else if (!bypass && GlobalState.filterBypassed) {
                  unBypassFilter();
                }
                GlobalState.filterBypassed = bypass;
              }}
              vcId={undefined}
              adsrDebugName='fmSynthDemoFilter'
              adsrAudioThreadData={filterAdsrs.audioThreadData}
            />
          </>
        )}
      </div>
      <div className='midi-keyboard-wrapper'>
        <MidiKeyboard
          octaveOffset={octaveOffset}
          onOctaveOffsetChange={newOctaveOffset => {
            setOctaveOffset(newOctaveOffset);
            sentryRecord('Octave offset change', { newOctaveOffset });
          }}
          onAttack={midiNumber => playNote(midiNumber)}
          onRelease={midiNumber => releaseNote(midiNumber)}
        />
      </div>
    </div>
  );
};

setTimeout(() => {
  const elem = document.getElementById('simd-status');

  if (!navigator.requestMIDIAccess) {
    elem!.innerHTML +=
      '<br /><br/><span style="color: rgb(233,142,24);">Web MIDI support not detected; external MIDI device support not available</span>';
  } else {
    elem!.innerHTML += '<br/><br/><span>Web MIDI support detected</span>';
  }
  getSentry()?.setContext('hasWebMIDISupport', {
    hasWebMIDISupport: !!navigator.requestMIDIAccess,
    hasSharedArrayBufferSupport: typeof SharedArrayBuffer !== 'undefined',
  });

  if (typeof SharedArrayBuffer === 'undefined') {
    elem!.innerHTML +=
      '<br /><br/><span style="color: rgb(233,142,24);"><code>SharedArrayBuffer</code> support not detected; some visualizations and other features are not available.</span>';
  }
}, 1000);

if (environmentIsValid) {
  root.render(<FMSynthDemo />);
}
