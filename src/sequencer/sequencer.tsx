import React, { Suspense } from 'react';
import { Map as ImmMap } from 'immutable';
import * as R from 'ramda';
import { UnimplementedError, UnreachableException } from 'ameo-utils';

import {
  mkContainerRenderHelper,
  mkContainerCleanupHelper,
  mkContainerHider,
  mkContainerUnhider,
} from 'src/reactUtils';
import {
  AudioConnectables,
  ConnectableInput,
  ConnectableOutput,
  updateConnectables,
} from 'src/patchNetwork';
import Loading from 'src/misc/Loading';
import { buildMIDINode, MIDINode } from 'src/patchNetwork/midiNode';
import { SampleDescriptor, getSample } from 'src/sampleLibrary';
import {
  buildSequencerReduxInfra,
  buildInitialState,
  SequencerReduxInfra,
  SequencerReduxState,
  VoiceTarget,
  SchedulerScheme,
  buildSequencerConfig,
} from './redux';
import { SequencerUIProps } from 'src/sequencer/SequencerUI/SequencerUI';
import { AsyncOnce } from 'src/util';
import { BeatSchedulersBuilderByVoiceType } from 'src/sequencer/scheduler';

const ctx = new AudioContext();

const SequencerUI = React.lazy(() => import('./SequencerUI'));

const reduxInfraMap: Map<string, SequencerReduxInfra> = new Map();

interface SerializedSequencer {
  currentEditingVoiceIx: number;
  voices: VoiceTarget[];
  sampleBank: { [voiceIx: number]: SampleDescriptor | null };
  marks: boolean[][];
  bpm: number;
  isPlaying: boolean;
  midiOutputCount: number;
  gateOutputCount: number;
  schedulerScheme: SchedulerScheme;
}

const getSequencerDOMElementId = (vcId: string) => `sequencer-${vcId}`;

const serializeSequencer = (vcId: string): string => {
  const reduxInfra = reduxInfraMap.get(vcId);
  if (!reduxInfra) {
    console.error(
      `Missing entry in sequencer redux infra map for vcId ${vcId} when trying to serialize`
    );
    return '';
  }

  const {
    currentEditingVoiceIx,
    voices,
    marks,
    bpm,
    isPlaying,
    midiOutputs,
    gateOutputs,
    schedulerScheme,
    sampleBank,
  } = reduxInfra.getState().sequencer;
  console.log({ isPlaying });

  const serialized: SerializedSequencer = {
    currentEditingVoiceIx,
    voices,
    sampleBank: Object.values(sampleBank).map(item => (item ? item.descriptor : item)),
    marks,
    bpm,
    isPlaying,
    midiOutputCount: midiOutputs.length,
    gateOutputCount: gateOutputs.length,
    schedulerScheme,
  };

  return JSON.stringify(serialized);
};

export const buildGateOutput = (): ConstantSourceNode => {
  const csn = new ConstantSourceNode(ctx);
  csn.offset.value = 0;
  csn.start();
  return csn;
};

const SequencerAWPRegistered = new AsyncOnce(() =>
  ctx.audioWorklet.addModule('/SequencerWorkletProcessor.js')
);
const initSequenceAWP = async (vcId: string): Promise<AudioWorkletNode> => {
  await SequencerAWPRegistered.get();
  const workletHandle = new AudioWorkletNode(ctx, 'sequencer-audio-worklet-node-processor');

  workletHandle.port.onmessage = msg => {
    switch (msg.data.type) {
      case 'triggerVoice': {
        const state = reduxInfraMap.get(vcId)!.getState().sequencer;
        const voiceIx = msg.data.i;

        BeatSchedulersBuilderByVoiceType[state.voices[voiceIx].type](
          state,
          voiceIx,
          state.voices[voiceIx] as any
        );
        break;
      }
      default: {
        console.warn(`Unhandled message type received from sequencer AWP: ${msg.data.type}`);
      }
    }
  };
  const state = reduxInfraMap.get(vcId)!.getState().sequencer;
  workletHandle.port.postMessage({ type: 'configure', config: buildSequencerConfig(state) });

  return workletHandle;
};

const initSampleBank = async (sampleBank: { [voiceIx: number]: SampleDescriptor | null }) =>
  (
    await Promise.all(
      Object.entries(sampleBank).map(async ([voiceIx, descriptor]) => {
        if (!descriptor) {
          return [+voiceIx, null] as const;
        }

        try {
          const buffer = await getSample(descriptor);
          return [+voiceIx, { descriptor, buffer }] as const;
        } catch (err) {
          console.warn(`Unable to load sample named "${descriptor.name}": `, err);
          // Unable to load the referenced sample for whatever reason
          return [+voiceIx, null] as const;
        }
      })
    )
  ).reduce(
    (acc, [voiceIx, val]) => acc.then(acc => ({ ...acc, [voiceIx]: val })),
    Promise.resolve({}) as Promise<{
      [voiceIx: number]: { descriptor: SampleDescriptor; buffer: AudioBuffer } | null;
    }>
  );

const deserializeSequencer = (serialized: string, vcId: string): SequencerReduxState => {
  const {
    currentEditingVoiceIx,
    voices,
    sampleBank,
    marks,
    bpm,
    isPlaying,
    midiOutputCount,
    gateOutputCount,
    schedulerScheme,
  }: SerializedSequencer = JSON.parse(serialized);

  initSampleBank(sampleBank).then(sampleBank => {
    const reduxInfra = reduxInfraMap.get(vcId);
    if (!reduxInfra) {
      console.warn('No redux infra found after loading samples');
      return;
    }
    reduxInfra.dispatch(reduxInfra.actionCreators.sequencer.SET_SAMPLES(sampleBank));
  });

  const state = {
    currentEditingVoiceIx,
    activeBeats: voices.map(() => 0),
    voices,
    sampleBank: 'LOADING' as const,
    marks,
    bpm,
    isPlaying: false, // This will be set asynchronously if auto-start enabled
    outputGainNode: new GainNode(ctx),
    midiOutputs: R.times(
      () =>
        buildMIDINode(() => {
          throw new UnreachableException('MIDI output of sequencer has no inputs');
        }),
      midiOutputCount
    ),
    gateOutputs: R.times(buildGateOutput, gateOutputCount),
    schedulerScheme,
    awpHandle: undefined,
  };

  initSequenceAWP(vcId).then(awpHandle => {
    const reduxInfra = reduxInfraMap.get(vcId);
    if (!reduxInfra) {
      console.warn('No redux infra found for sequencer when trying to auto-start');
      return;
    }
    reduxInfra.dispatch(reduxInfra.actionCreators.sequencer.SET_AWP_HANDLE(awpHandle));

    // If the sequencer was playing when we saved, re-start it and set a new valid handle
    if (isPlaying) {
      reduxInfra.dispatch(reduxInfra.actionCreators.sequencer.TOGGLE_IS_PLAYING());
    }
  });

  return state;
};

const loadInitialState = (stateKey: string, vcId: string) => {
  const serializedState = localStorage.getItem(stateKey);
  if (!serializedState) {
    return buildInitialState();
  }

  try {
    return deserializeSequencer(serializedState, vcId);
  } catch (_err) {
    console.error(
      `Failed to parse serialized state for sequencer id ${vcId}; building default state.`
    );
    return buildInitialState();
  }
};

const LazySequencerUI: React.FC<SequencerUIProps> = props => (
  <Suspense fallback={<Loading />}>
    <SequencerUI {...props} />
  </Suspense>
);

export const get_sequencer_audio_connectables = (vcId: string): AudioConnectables => {
  const reduxInfra = reduxInfraMap.get(vcId);

  // Initialization is async, so we may not yet have a valid Redux state handle at this point.
  if (!reduxInfra) {
    throw new UnreachableException(
      "Expected to find redux infra for sequencer when initializing, but didn't find it"
    );
  }
  const reduxState = reduxInfra.getState();

  let outputs = ImmMap<string, ConnectableOutput>().set('output', {
    node: reduxInfra.getState().sequencer.outputGainNode,
    type: 'customAudio',
  });
  outputs = reduxState.sequencer.midiOutputs.reduce(
    (acc: ImmMap<string, ConnectableOutput>, node: MIDINode, i: number) =>
      acc.set(`midi_output_${i + 1}`, { node, type: 'midi' }),
    outputs
  );

  return {
    vcId,
    inputs: ImmMap<string, ConnectableInput>(),
    outputs,
  };
};

export const init_sequencer = (stateKey: string) => {
  const vcId = stateKey.split('_')[1]!;

  const domId = getSequencerDOMElementId(vcId);
  const elem = document.createElement('div');
  elem.id = domId;
  elem.setAttribute(
    'style',
    'z-index: 2; width: 100%; height: 100vh; position: absolute; top: 0; left: 0; display: none;'
  );
  document.getElementById('content')!.appendChild(elem);

  const initialState = loadInitialState(stateKey, vcId);
  const reduxInfra = buildSequencerReduxInfra(initialState);
  if (!!reduxInfraMap.get(vcId)) {
    console.error(`Existing entry in sequencer redux infra map for vcId ${vcId}; overwriting...`);
  }
  reduxInfraMap.set(vcId, reduxInfra);

  // Since we asynchronously init, we need to update our connections manually once we've created a valid internal state
  updateConnectables(vcId, get_sequencer_audio_connectables(vcId));

  mkContainerRenderHelper({
    Comp: LazySequencerUI,
    store: reduxInfra.store,
    getProps: () => ({
      vcId,
      ...reduxInfra,
    }),
  })(domId);
};

export const cleanup_sequencer = (stateKey: string) => {
  const vcId = stateKey.split('_')[1]!;

  // Stop it if it is playing
  const reduxInfra = reduxInfraMap.get(vcId)!;
  if (!reduxInfra) {
    throw new Error(`No sequencer Redux infra map entry for sequencer with vcId ${vcId}`);
  }
  const serialized = serializeSequencer(vcId);
  if (reduxInfra.getState().sequencer.isPlaying) {
    reduxInfra.dispatch(reduxInfra.actionCreators.sequencer.TOGGLE_IS_PLAYING());
  }

  localStorage.setItem(stateKey, serialized);

  mkContainerCleanupHelper()(getSequencerDOMElementId(vcId));
};

export const hide_sequencer = mkContainerHider(getSequencerDOMElementId);

export const unhide_sequencer = mkContainerUnhider(getSequencerDOMElementId);

const schedulerFnBySchedulerScheme: {
  [K in SchedulerScheme]: (bpm: number, startBeat: number, endBeat: number) => number[];
} = {
  [SchedulerScheme.Stable]: (bpm: number, startBeat: number, endBeat: number) =>
    R.range(startBeat, endBeat + 1).map(beat => beat / (bpm / 60)),
  [SchedulerScheme.Random]: (_bpm: number, _startBeat: number, _endBeat: number) => {
    throw new UnimplementedError();
  },
  [SchedulerScheme.Swung]: (_bpm: number, _startBeat: number, _endBeat: number) => {
    throw new UnimplementedError();
  },
};

export const getBeatTimings = (
  scheme: SchedulerScheme,
  bpm: number,
  startBeat: number,
  endBeat: number
): number[] => schedulerFnBySchedulerScheme[scheme](bpm, startBeat, endBeat);
