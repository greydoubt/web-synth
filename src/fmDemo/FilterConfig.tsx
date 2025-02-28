import * as R from 'ramda';
import React, { useMemo, useState } from 'react';
import ControlPanel from 'react-control-panel';

import type { AudioThreadData } from 'src/controls/adsr2/adsr2';
import type { Adsr } from 'src/graphEditor/nodes/CustomAudio/FMSynth/FMSynth';
import { OverridableAudioParam } from 'src/graphEditor/nodes/util';
import HelpIcon from 'src/misc/HelpIcon';
import type { FilterParams } from 'src/redux/modules/synthDesigner';
import type { ADSR2Module } from 'src/synthDesigner/ADSRModule';
import {
  AbstractFilterModule,
  buildAbstractFilterModule,
  type FilterCSNs,
} from 'src/synthDesigner/biquadFilterModule';
import { FilterType, getSettingsForFilterType } from 'src/synthDesigner/filterHelpers';
import { msToSamples, samplesToMs } from 'src/util';

export class FilterContainer {
  private ctx: AudioContext;
  public csns: FilterCSNs;
  private input: GainNode;
  private output: GainNode;
  private inner: AbstractFilterModule;

  constructor(ctx: AudioContext, params: FilterParams) {
    this.ctx = ctx;
    this.input = new GainNode(ctx);
    this.output = new GainNode(ctx);
    this.csns = {
      frequency: new OverridableAudioParam(ctx),
      detune: new OverridableAudioParam(ctx),
      Q: new OverridableAudioParam(ctx),
      gain: new OverridableAudioParam(ctx),
    };
    this.csns.Q.manualControl.offset.value = params.Q ?? 0;
    this.csns.detune.manualControl.offset.value = params.detune;
    this.csns.frequency.manualControl.offset.value = params.frequency;
    this.csns.gain.manualControl.offset.value = params.gain ?? 0;

    this.inner = buildAbstractFilterModule(ctx, params.type, this.csns);
    this.input.connect(this.inner.getInput());
    this.inner.getOutput().connect(this.output);
  }

  public set(key: 'frequency' | 'detune' | 'gain' | 'Q', val: number) {
    this.csns[key].manualControl.offset.value = val;
  }
  public setType(newType: FilterType) {
    this.input.disconnect(this.inner.getInput());
    this.inner.destroy();

    this.inner = buildAbstractFilterModule(this.ctx, newType, this.csns);
    this.input.connect(this.inner.getInput());
    this.inner.getOutput().connect(this.output);
  }
  public setAll(params: FilterParams) {
    this.setType(params.type);
    Object.keys(params)
      .filter(k => (this.csns as any)[k])
      .forEach(k => this.set(k as any, params[k as keyof typeof params] as any));
  }

  public getInput() {
    return this.input;
  }
  public getOutput() {
    return this.output;
  }
}

const handleFilterChange = (
  filters: FilterContainer[],
  adsrs: ADSR2Module,
  state: { params: FilterParams; envelope: Adsr; bypass: boolean; enableADSR: boolean },
  key: string,
  val: any
) => {
  const newState = { ...state, envelope: { ...state.envelope }, params: { ...state.params } };
  switch (key) {
    case 'frequency':
    case 'Q':
    case 'gain':
    case 'detune':
      newState.params[key] = val;
      filters.forEach(filter => filter.set(key, val));
      break;
    case 'type': {
      filters.forEach(filter => filter.setType(val));
      newState.params.type = val;
      break;
    }
    case 'enable envelope': {
      newState.enableADSR = val;
      break;
    }
    case 'adsr length ms': {
      adsrs.setLengthMs(val);
      newState.envelope.lenSamples = msToSamples(val);
      break;
    }
    case 'log scale': {
      adsrs.setLogScale(val);
      newState.envelope.logScale = val;
      break;
    }
    case 'adsr': {
      adsrs.setState(val);
      newState.envelope = val;
      break;
    }
    case 'bypass': {
      newState.bypass = val;
      break;
    }
    default: {
      console.error('Unhandled key in filter config: ', key);
    }
  }
  return newState;
};

interface FilterConfigProps {
  initialState: {
    params: FilterParams;
    envelope: Adsr;
    bypass: boolean;
    enableADSR: boolean;
  };
  filters: FilterContainer[];
  adsrs: ADSR2Module;
  onChange: (params: FilterParams, envelope: Adsr, bypass: boolean, enableADSR: boolean) => void;
  vcId: string | undefined;
  adsrDebugName?: string;
  adsrAudioThreadData: AudioThreadData;
}

const FilterConfig: React.FC<FilterConfigProps> = ({
  initialState,
  filters,
  adsrs,
  onChange,
  vcId,
  adsrDebugName,
  adsrAudioThreadData,
}) => {
  const [state, setState] = useState(initialState);

  const settings = useMemo(
    () =>
      getSettingsForFilterType({
        filterType: state.params.type,
        includeADSR: { adsrAudioThreadData },
        includeBypass: true,
        vcId,
        adsrDebugName,
      })
        .filter(s => {
          if (!state.enableADSR && (s.label === 'adsr' || s.label === 'adsr length ms')) {
            return false;
          } else if (state.enableADSR && s.label === 'frequency') {
            return false;
          }
          return true;
        })
        .map(s => {
          delete (s as any).initial;
          return s;
        }),
    [state.enableADSR, state.params.type, vcId, adsrDebugName, adsrAudioThreadData]
  );
  const controlPanelState = useMemo(
    () => ({
      ...state.params,
      'enable envelope': state.enableADSR,
      adsr: { ...state.envelope, outputRange: [20, 44_100 / 2] },
      bypass: state.bypass,
      'adsr length ms': R.clamp(0, 10000, samplesToMs(state.envelope.lenSamples)),
    }),
    [state.bypass, state.enableADSR, state.envelope, state.params]
  );

  return (
    <ControlPanel
      className='fm-synth-filter-control-panel'
      style={{ width: 700 }}
      title={
        <>
          FILTER <HelpIcon link='filter' size={14} color='rgb(161, 161, 161)' />
        </>
      }
      settings={settings}
      state={controlPanelState}
      onChange={(key: string, val: any) => {
        const newState = handleFilterChange(filters, adsrs, state, key, val);
        onChange(newState.params, newState.envelope, newState.bypass, newState.enableADSR);
        setState(newState);
      }}
    />
  );
};

export default FilterConfig;
