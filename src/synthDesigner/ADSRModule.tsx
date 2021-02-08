import { UnreachableException } from 'ameo-utils';
import { ADSRValues, defaultAdsrEnvelope } from 'src/controls/adsr';
import { AdsrStep } from 'src/graphEditor/nodes/CustomAudio/FMSynth/FMSynth';
import { AsyncOnce } from 'src/util';

const ADSR2AWPRegistered = new AsyncOnce(() =>
  new AudioContext().audioWorklet.addModule(
    '/ADSR2AWP.js?cacheBust=' + btoa(Math.random().toString())
  )
);
const ADSRWasm = new AsyncOnce(() =>
  fetch(
    '/adsr.wasm' + window.location.href.includes('localhost')
      ? ''
      : `?cacheBust=${btoa(Math.random().toString())}`
  ).then(res => res.arrayBuffer())
);

export interface ADSR2Params {
  minValue?: number;
  maxValue?: number;
  lengthMs?: number;
  loopPoint?: number | null;
  releaseStartPhase: number;
  steps: AdsrStep[];
}

export class ADSR2Module {
  private ctx: AudioContext;
  private scale: GainNode;
  private shift: ConstantSourceNode;
  private awp: AudioWorkletNode | undefined;

  constructor(ctx: AudioContext, params: ADSR2Params) {
    this.ctx = ctx;

    this.scale = new GainNode(ctx);
    this.shift = new ConstantSourceNode(ctx);
    this.setOutputRange([params.minValue ?? 0, params.maxValue ?? 1]);
    this.shift.start();
    this.init(params);
  }

  private static encodeADSRSteps(steps: AdsrStep[]): Float32Array {
    const encoded = new Float32Array(steps.length * 4);
    steps.forEach((step, i) => {
      encoded[i * 4] = step.x;
      encoded[i * 4 + 1] = step.y;
      encoded[i * 4 + 2] = { instant: 0, linear: 1, exponential: 2 }[step.ramper.type];
      encoded[i * 4 + 3] = step.ramper.type === 'exponential' ? step.ramper.exponent : 0;
    });
    return encoded;
  }

  private async init(params: ADSR2Params) {
    const [wasmBytes] = await Promise.all([ADSRWasm.get(), ADSR2AWPRegistered.get()] as const);
    this.awp = new AudioWorkletNode(this.ctx, 'adsr2-awp');
    this.awp.port.postMessage({
      type: 'setWasmBytes',
      wasmBytes,
      encodedSteps: ADSR2Module.encodeADSRSteps(params.steps),
      loopPoint: params.loopPoint,
      lenMs: params.lengthMs,
      releaseStartPhase: params.releaseStartPhase,
    });
    this.awp.connect(this.scale).connect(this.shift.offset);
  }

  public getOutput(): ConstantSourceNode {
    return this.shift;
  }

  public setSteps(newSteps: AdsrStep[]) {
    if (!this.awp) {
      console.error('Tried to set new steps before AWP initialized');
      return;
    }
    const encodedSteps = ADSR2Module.encodeADSRSteps(newSteps);
    this.awp.port.postMessage({ type: 'setSteps', encodedSteps });
  }

  public setLoopPoint(newLoopPoint: number | null | undefined) {
    if (!this.awp) {
      console.error("Can't set ADSR2 loop point before AWP is initialized");
      return;
    }
    this.awp.port.postMessage({ type: 'setLoopPoint', loopPoint: newLoopPoint });
  }

  public setReleaseStartPhase(newReleaseStartPhase: number | null | undefined) {
    if (!this.awp) {
      console.error("Can't set ADSR2 release start phase before AWP is initialized");
      return;
    }
    this.awp.port.postMessage({
      type: 'setReleaseStartPhase',
      releaseStartPhase: newReleaseStartPhase,
    });
  }

  public setLengthMs(newLengthMs: number) {
    if (!this.awp) {
      console.error('Failed to set ADSR2 length ms due to AWP not being initialized');
      return;
    }
    this.awp.port.postMessage({ type: 'setLenMs', lenMs: newLengthMs });
  }

  public setOutputRange([minVal, maxVal]: [number, number]) {
    this.scale.gain.value = maxVal - minVal;
    this.shift.offset.value = minVal;
  }

  public gate() {
    if (!this.awp) {
      console.error('Failed to gate ADSR2 due to AWP not being initialized');
      return;
    }
    this.awp.port.postMessage({ type: 'gate' });
  }

  public ungate() {
    if (!this.awp) {
      console.error('Failed to ungate ADSR2 due to AWP not being initialized');
      return;
    }
    this.awp.port.postMessage({ type: 'ungate' });
  }

  public destroy() {
    this.scale.disconnect(this.shift);
    if (!this.awp) {
      throw new UnreachableException('Tried to destroy AWP before initialization');
    }
    this.awp.port.postMessage({ type: 'shutdown' });
  }
}

export class ADSRModule extends ConstantSourceNode {
  private ctx: AudioContext;
  public minValue: number;
  public maxValue: number;
  public lengthMs = 1000;
  public envelope: ADSRValues = defaultAdsrEnvelope;

  constructor(
    ctx: AudioContext,
    {
      minValue = 0,
      maxValue = 1,
      lengthMs = 1000,
    }: { minValue?: number; maxValue?: number; lengthMs?: number }
  ) {
    super(ctx);

    this.ctx = ctx;
    this.minValue = minValue;
    this.maxValue = maxValue;
    this.lengthMs = lengthMs;

    this.offset.setValueAtTime(this.minValue, ctx.currentTime);
  }

  public setLengthMs(newLengthMs: number) {
    this.lengthMs = newLengthMs;
  }

  public setMinValue(newMinValue: number) {
    this.minValue = newMinValue;
  }

  public setMaxValue(newMaxValue: number) {
    this.maxValue = newMaxValue;
  }

  public setEnvelope(newEnvelope: ADSRValues) {
    this.envelope = newEnvelope;
  }

  /**
   * Triggers the ADSR to implement the signal, triggering ramps to each of the levels defined by the envelope to the
   * underlying `ConstantSourceNode` and effecting all connected `AudioParam`s
   */
  public gate() {
    if (!this.lengthMs) {
      console.warn('Tried to gate ADSR before value recorder initialized');
      return;
    }

    this.offset.cancelScheduledValues(0);

    const range = this.maxValue - this.minValue;
    const { attack, decay } = this.envelope;

    // Ramp to the attack
    if (attack.pos > 0) {
      // Firefox is 100% broken for exponential ramping and seems to have serious bugs for various `AudioParam`
      // methods including `exponentialRampToValueAtTime` and possibly `setValueCurveAtTime` and `cancelScheduledValues`.
      if (navigator.userAgent.includes('Firefox/')) {
        this.offset.linearRampToValueAtTime(
          this.minValue + attack.magnitude * range,
          this.ctx.currentTime + (attack.pos * this.lengthMs) / 1000.0
        );
      } else {
        this.offset.exponentialRampToValueAtTime(
          Math.max(this.minValue + attack.magnitude * range, 0.0001),
          this.ctx.currentTime + (attack.pos * this.lengthMs) / 1000.0
        );
      }
    } else {
      this.offset.setValueAtTime(this.minValue + attack.magnitude * range, this.ctx.currentTime);
    }
    // Ramp to the decay and hold there
    if (decay.pos - attack.pos > 0) {
      if (navigator.userAgent.includes('Firefox/')) {
        this.offset.linearRampToValueAtTime(
          this.minValue + decay.magnitude * range,
          this.ctx.currentTime + (decay.pos * this.lengthMs) / 1000.0
        );
      } else {
        this.offset.exponentialRampToValueAtTime(
          Math.max(this.minValue + decay.magnitude * range, 0.0001),
          this.ctx.currentTime + (decay.pos * this.lengthMs) / 1000.0
        );
      }
    } else {
      this.offset.setValueAtTime(this.minValue + decay.magnitude * range, this.ctx.currentTime);
    }
  }

  /**
   * Triggers the start of the release.  This will override all other envelope ramp events that are currently queued
   * and start ramping to zero immediately.
   */
  public ungate() {
    if (!this.lengthMs) {
      console.warn('Tried to ungate ADSR before value recorder initialized');
      return;
    }

    const { release } = this.envelope;

    // Clear any queued ramp events
    this.offset.cancelScheduledValues(0);

    const releaseDuration = ((1.0 - release.pos) * this.lengthMs) / 1000.0;
    if (navigator.userAgent.includes('Firefox/')) {
      this.offset.linearRampToValueAtTime(
        this.minValue,
        this.ctx.currentTime + releaseDuration * 0.35 // shorten the release since linear releases sound way longer
      );
    } else {
      this.offset.exponentialRampToValueAtTime(
        this.minValue === 0 ? 0.0001 : this.minValue,
        this.ctx.currentTime + releaseDuration
      );
    }
  }
}
