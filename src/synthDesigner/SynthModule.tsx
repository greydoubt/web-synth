import { UnreachableException } from 'ameo-utils';
import * as R from 'ramda';
import React, { useCallback, useMemo, useRef, useState } from 'react';
import ControlPanel from 'react-control-panel';
import { Provider, shallowEqual } from 'react-redux';

import { saveSynthVoicePreset } from 'src/api';
import {
  mkControlPanelADSR2WithSize,
  type ADSRWithOutputRange,
} from 'src/controls/adsr2/ControlPanelADSR2';
import { renderGenericPresetSaverWithModal } from 'src/controls/GenericPresetPicker/GenericPresetSaver';
import { ConnectedFMSynthUI } from 'src/fmSynth/FMSynthUI';
import type { Adsr, AdsrParams } from 'src/graphEditor/nodes/CustomAudio/FMSynth/FMSynth';
import { updateConnectables } from 'src/patchNetwork/interface';
import { getState, store, useSelector } from 'src/redux';
import { voicePresetIdsSelector } from 'src/redux/modules/presets';
import { getSynthDesignerReduxInfra, type SynthModule } from 'src/redux/modules/synthDesigner';
import { getSentry } from 'src/sentry';
import { get_synth_designer_audio_connectables, getVoicePreset } from 'src/synthDesigner';
import { msToSamples, samplesToMs } from 'src/util';
import { Filter as FilterModule } from './Filter';

const PRESETS_CONTROL_PANEL_STYLE = { height: 97, width: 400 };

const PresetsControlPanel: React.FC<{
  index: number;
  stateKey: string;
}> = ({ index, stateKey }) => {
  const controlPanelContext = useRef<{ preset: string } | null>(null);
  const voicePresetIds = useSelector(voicePresetIdsSelector, shallowEqual);
  const { dispatch, actionCreators } = getSynthDesignerReduxInfra(stateKey);

  const ctxCb = useCallback((ctx: { preset: string }) => {
    controlPanelContext.current = ctx;
  }, []);
  const settings = useMemo(
    () => [
      {
        label: 'preset',
        type: 'select',
        options: { blank: 'blank', ...voicePresetIds },
        initial: 'blank',
      },
      {
        label: 'load preset',
        type: 'button',
        action: () => {
          if (!controlPanelContext.current) {
            console.error('Control panel context never set!');
            return;
          }

          const presetId = controlPanelContext.current.preset;
          getSentry()?.captureMessage('Load synth designer voice preset', { tags: { presetId } });
          const allVoicePresets = getState().presets.voicePresets;
          if (typeof allVoicePresets === 'string') {
            console.error("Somehow voice presets aren't loaded at this point...");
            return;
          }

          const preset =
            presetId === 'blank' ? null : allVoicePresets.find(R.propEq('id', +presetId));
          if (preset === undefined) {
            console.error(
              `No voice preset found with id ${presetId} even though we have one with that id in the control panel`
            );
            return;
          }

          dispatch(
            actionCreators.synthDesigner.SET_VOICE_STATE(index, preset ? preset.body : null)
          );
        },
      },
      {
        label: 'save preset',
        type: 'button',
        action: async () => {
          const { name: title, description } = await renderGenericPresetSaverWithModal({
            description: true,
          });
          const presetBody = getVoicePreset(stateKey, index);
          await saveSynthVoicePreset({ title, description: description ?? '', body: presetBody });
        },
      },
    ],
    [actionCreators.synthDesigner, dispatch, index, stateKey, voicePresetIds]
  );

  return (
    <ControlPanel proxy contextCb={ctxCb} style={PRESETS_CONTROL_PANEL_STYLE} settings={settings} />
  );
};

interface SynthControlPanelProps extends Pick<SynthModule, 'masterGain' | 'pitchMultiplier'> {
  stateKey: string;
  index: number;
  gainEnvelope: AdsrParams;
  gainADSRLength: number;
}

const buildSynthControlPanelSettings = (vcId: string) => [
  {
    type: 'range',
    label: 'volume',
    min: -1,
    max: 1,
    step: 0.008,
  },
  {
    type: 'text',
    label: 'pitch multiplier',
  },
  {
    type: 'range',
    label: 'adsr length ms',
    min: 50,
    max: 10000,
  },
  {
    type: 'checkbox',
    label: 'log scale',
  },
  {
    type: 'custom',
    label: 'gain envelope',
    Comp: mkControlPanelADSR2WithSize(380, 200, vcId, 'synthDesignerGainEnvelope'),
  },
];

const SynthControlPanelInner: React.FC<SynthControlPanelProps> = props => {
  const [localPitchMultiplier, setLocalPitchMultiplier] = useState<string | null>(null);
  const { dispatch, actionCreators, getState } = getSynthDesignerReduxInfra(props.stateKey);
  const [gainADSRLengthMs, setGainADSRLengthMs] = useState<number>(props.gainADSRLength);
  const [gainEnvelope, setGainEnvelope] = useState<Adsr>({
    ...props.gainEnvelope,
    lenSamples: msToSamples(gainADSRLengthMs),
  });

  const handleSynthChange = useCallback(
    (key: string, val: any) => {
      switch (key) {
        case 'volume': {
          dispatch(actionCreators.synthDesigner.SET_SYNTH_MASTER_GAIN(props.index, val));
          return;
        }
        case 'gain envelope': {
          setGainEnvelope(val);
          const fmSynth = getState().synthDesigner.synths[props.index].fmSynth;
          fmSynth.handleAdsrChange(-1, val);
          return;
        }
        case 'adsr length ms': {
          setGainADSRLengthMs(val);
          const fmSynth = getState().synthDesigner.synths[props.index].fmSynth;
          fmSynth.handleAdsrChange(-1, {
            ...fmSynth.gainEnvelope,
            lenSamples: { type: 'constant', value: msToSamples(val) },
          });
          setGainEnvelope({ ...gainEnvelope, lenSamples: val });
          return;
        }
        case 'log scale': {
          const fmSynth = getState().synthDesigner.synths[props.index].fmSynth;
          fmSynth.handleAdsrChange(-1, {
            ...fmSynth.gainEnvelope,
            logScale: val,
          });
          setGainEnvelope({ ...gainEnvelope, logScale: val });
          return;
        }
        case 'pitch multiplier': {
          setLocalPitchMultiplier(val);
          const value = Number.parseFloat(val);
          if (Number.isNaN(value)) {
            return;
          }
          dispatch(actionCreators.synthDesigner.SET_PITCH_MULTIPLIER(props.index, value));
          return;
        }
        default: {
          console.warn('Unhandled key in synth control panel: ', key);
        }
      }
    },
    [actionCreators.synthDesigner, dispatch, getState, props.index]
  );

  const state = useMemo(() => {
    const gainEnvelopeState: ADSRWithOutputRange = {
      ...gainEnvelope,
      lenSamples: msToSamples(gainADSRLengthMs),
      outputRange: [0, 1],
    };

    return {
      volume: props.masterGain,
      'adsr length ms': gainADSRLengthMs,
      'gain envelope': gainEnvelopeState,
      'pitch multiplier': localPitchMultiplier ?? props.pitchMultiplier?.toString() ?? 1,
      'log scale': gainEnvelope.logScale,
    };
  }, [
    props.masterGain,
    gainADSRLengthMs,
    gainEnvelope,
    props.pitchMultiplier,
    localPitchMultiplier,
  ]);
  const vcId = props.stateKey.split('_')[1];
  const settings = useMemo(() => buildSynthControlPanelSettings(vcId), [vcId]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <ControlPanel
        title='SYNTH'
        settings={settings}
        onChange={handleSynthChange}
        state={state}
        width={400}
      />
      <PresetsControlPanel index={props.index} stateKey={props.stateKey} />
    </div>
  );
};
const SynthControlPanel = React.memo(SynthControlPanelInner);

interface SynthModuleCompProps {
  index: number;
  synth: SynthModule;
  stateKey: string;
  isHidden: boolean;
  vcId: string;
  children?: React.ReactNode;
}

const SynthModuleCompInner: React.FC<SynthModuleCompProps> = ({
  index,
  synth,
  stateKey,
  children = null,
  isHidden,
  vcId,
}) => {
  const { dispatch, actionCreators } = getSynthDesignerReduxInfra(stateKey);
  const filterEnvelope = useMemo(
    (): ADSRWithOutputRange => ({ ...synth.filterEnvelope, outputRange: [20, 20_000] as const }),
    [synth.filterEnvelope]
  );
  const getFMSynthOutput = useCallback(async () => {
    const output = get_synth_designer_audio_connectables(stateKey).outputs.get('masterOutput');
    if (!output || output.type !== 'customAudio') {
      throw new UnreachableException('Missing `masterGain` on synth designer audio connectables');
    }
    return output.node as AudioNode;
  }, [stateKey]);

  return (
    <div className='synth-module'>
      <div
        className='synth-remove-button'
        onClick={() => {
          dispatch(actionCreators.synthDesigner.DELETE_SYNTH_MODULE(index));
          const vcId = stateKey.split('_')[1]!;
          const newConnectables = get_synth_designer_audio_connectables(stateKey);
          updateConnectables(vcId, newConnectables);
        }}
      >
        ×
      </div>

      <SynthControlPanel
        masterGain={synth.masterGain}
        pitchMultiplier={synth.pitchMultiplier}
        stateKey={stateKey}
        index={index}
        gainEnvelope={synth.fmSynth.gainEnvelope}
        gainADSRLength={samplesToMs(synth.fmSynth.gainEnvelope.lenSamples.value)}
      />

      <ConnectedFMSynthUI
        synth={synth.fmSynth}
        synthID={`${stateKey}_${index}`}
        getFMSynthOutput={getFMSynthOutput}
        isHidden={isHidden}
        vcId={vcId}
      />

      <FilterModule
        synthIx={index}
        params={synth.filterParams}
        filterEnvelope={filterEnvelope}
        stateKey={stateKey}
        bypass={synth.filterBypassed}
        adsrLength={synth.filterADSRLength}
        enableEnvelope={synth.filterEnvelopeEnabled ?? false}
      />

      <div className='effects'>{children}</div>
    </div>
  );
};

const SynthModuleComp: React.FC<SynthModuleCompProps> = ({ ...props }) => (
  <Provider store={store}>
    <SynthModuleCompInner {...props} />
  </Provider>
);
export default React.memo(SynthModuleComp);
