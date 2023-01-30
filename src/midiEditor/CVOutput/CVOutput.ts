import { get, writable, type Unsubscriber, type Writable } from 'svelte/store';

import { ADSR2Instance, type RenderedRegion } from 'src/controls/adsr2/adsr2';
import {
  AdsrLengthMode,
  type Adsr,
  type AdsrStep,
} from 'src/graphEditor/nodes/CustomAudio/FMSynth/FMSynth';
import DummyNode from 'src/graphEditor/nodes/DummyNode';
import { get_midi_editor_audio_connectables, MIDIEditorInstance } from 'src/midiEditor';
import type { MIDIEditorView } from 'src/midiEditor/MIDIEditorUIInstance';
import { updateConnectables } from 'src/patchNetwork/interface';
import { ADSR2Module, type ADSR2Params } from 'src/synthDesigner/ADSRModule';

export interface CVOutputState {
  name: string;
  adsr: Adsr;
  minValue: number;
  maxValue: number;
  isExpanded: boolean;
}

export type SerializedCVOutputState = CVOutputState;

export const buildDefaultCVOutputState = (
  midiEditorVcId: string,
  name: string
): SerializedCVOutputState => ({
  name,
  adsr: {
    audioThreadData: {
      phaseIndex: 0,
      debugName: `MIDI editor CV output for MIDI editor ${midiEditorVcId}`,
    },
    // temp value that will be changed when steps are added to the envelope
    lenSamples: 44_100 * 100,
    steps: [
      { x: 0, y: 0, ramper: { type: 'exponential', exponent: 1 } },
      { x: 4, y: 1, ramper: { type: 'exponential', exponent: 1 } },
    ],
    loopPoint: null,
    releasePoint: 1,
    lengthMode: AdsrLengthMode.Samples,
    logScale: false,
  },
  minValue: 0,
  maxValue: 1,
  isExpanded: true,
});

export class CVOutput {
  public name: string;
  public backend: ADSR2Module;
  private ctx: AudioContext;
  public dummyOutput: DummyNode = new DummyNode('MIDI editor CV dummy output');
  private onChangeUnsub: Unsubscriber;

  private uiInstance: ADSR2Instance | null = null;
  private parentInstance: MIDIEditorInstance;

  public state: Writable<CVOutputState>;

  constructor(
    parentInstance: MIDIEditorInstance,
    ctx: AudioContext,
    midiEditorVCId: string,
    name: string,
    state: SerializedCVOutputState
  ) {
    this.parentInstance = parentInstance;
    this.ctx = ctx;
    this.name = name;

    this.state = writable(state);

    const params: ADSR2Params = {
      // this will be updated later
      length: 1,
      lengthMode: AdsrLengthMode.Beats,
      releaseStartPhase: state.adsr.releasePoint,
      steps: state.adsr.steps,
      loopPoint: null,
      maxValue: state.maxValue,
      minValue: state.minValue,
      logScale: state.adsr.logScale,
    };

    this.backend = new ADSR2Module(ctx, params, 1);
    this.backend
      .onInit()
      .then(() =>
        updateConnectables(midiEditorVCId, get_midi_editor_audio_connectables(midiEditorVCId))
      );

    this.onChangeUnsub = this.state.subscribe(newState => this.handleStateChange(newState));
  }

  private handleStateChange(newState: CVOutputState) {
    try {
      // The UI envelope uses absolute beats, but the backend expects normalized [0, 1] values for
      // step positions.  So, we compute a length in beats and conver the steps to normalized values
      // before passing them to the backend.
      const lengthBeats = newState.adsr.steps[newState.adsr.steps.length - 1].x;
      const normalizedSteps: AdsrStep[] = newState.adsr.steps.map(step => ({
        ...step,
        x: step.x / lengthBeats,
      }));
      const releasePoint = this.parentInstance.playbackHandler.getLoopPoint();
      const normalizedReleasePoint = releasePoint === null ? null : releasePoint / lengthBeats;

      const newBackendState = {
        ...newState.adsr,
        steps: normalizedSteps,
        lengthMode: AdsrLengthMode.Beats,
        lenSamples: lengthBeats,
        releasePoint: normalizedReleasePoint ?? 1,
        loopPoint: releasePoint === null ? null : 0,
      };
      this.backend.setLength(AdsrLengthMode.Beats, lengthBeats);
      this.backend.setState(newBackendState);
    } catch (err) {
      console.error('CVOutput: error updating backend state', err);
    }
  }

  public registerUIInstance(uiInstance: ADSR2Instance) {
    this.uiInstance = uiInstance;
    if (this.parentInstance.uiInstance) {
      this.handleViewChange(this.parentInstance.uiInstance.view);
    }
  }

  public handleViewChange({ pxPerBeat, scrollHorizontalBeats }: MIDIEditorView) {
    if (!this.uiInstance) {
      console.warn('CVOutput: no UI instance registered');
      return;
    }

    const startBeat = scrollHorizontalBeats;
    const endBeat = startBeat + this.uiInstance.width / pxPerBeat;
    const newRenderedRegion: RenderedRegion = { start: startBeat, end: endBeat };
    this.uiInstance.setRenderedRegion(newRenderedRegion);
  }

  public startPlayback() {
    this.backend.gate(0);
  }

  public stopPlayback() {
    this.backend.ungate(0);
  }

  public setLoopPoint(_newLoopPoint: number | null) {
    if (this.parentInstance.uiInstance) {
      this.handleStateChange(get(this.state));
    }
  }

  public serialize(): SerializedCVOutputState {
    return get(this.state);
  }

  public destroy() {
    this.backend.destroy();
    this.onChangeUnsub();
  }
}
