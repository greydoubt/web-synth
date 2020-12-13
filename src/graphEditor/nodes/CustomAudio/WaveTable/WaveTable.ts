import { Map } from 'immutable';
import * as R from 'ramda';

import { ForeignNode } from 'src/graphEditor/nodes/CustomAudio/CustomAudio';
import { ConnectableInput, ConnectableOutput, updateConnectables } from 'src/patchNetwork';
import { OverridableAudioParam } from 'src/graphEditor/nodes/util';
import DummyNode from 'src/graphEditor/nodes/DummyNode';
import { UnreachableException } from 'ameo-utils';
import { base64ToArrayBuffer } from 'src/util';

// Manually generate some waveforms... for science

const SAMPLE_RATE = 44100;
const baseFrequency = 30; // 30hz

// Number of samples per waveform
const waveformLength = SAMPLE_RATE / baseFrequency;

const bufs: Float32Array[] = R.times(() => new Float32Array(waveformLength), 4);

// sine wave.  The sine function has a period of 2π, and we need to scale that the range of
// (sample_rage / desired_frequency)
for (let x = 0; x < waveformLength; x++) {
  bufs[0][x] = Math.sin(x * ((Math.PI * 2) / waveformLength));
}

// triangle wave; goes from -1 to 1 for one half the period and 1 to -1 for the other half
for (let i = 0; i < waveformLength; i++) {
  // Number of half-periods of this wave that this sample lies on.
  const halfPeriodIx = i / (waveformLength / 2);
  const isClimbing = Math.floor(halfPeriodIx) % 2 == 0;
  let val = 2 * (halfPeriodIx % 1) - 1;
  if (!isClimbing) {
    val = -val;
  }

  bufs[1][i] = val;
}

// square wave; half a period -1, half a period 1
for (let i = 0; i < waveformLength; i++) {
  const halfPeriodIx = i / (waveformLength / 2);
  const isFirstHalf = Math.floor(halfPeriodIx) % 2 == 0;

  bufs[2][i] = isFirstHalf ? -1 : 1;
}

// sawtooth; climb from -1 to 1 over 1 period
for (let i = 0; i < waveformLength; i++) {
  const periodIxFract = (i / waveformLength) % 1;

  bufs[3][i] = periodIxFract * 2 - 1;
}

export const getDefaultWavetableDef = () => [
  [bufs[0], bufs[1]],
  [bufs[2], bufs[3]],
];

let wavetableWasmBytes: ArrayBuffer | null = null;

let getBytesPromise: Promise<ArrayBuffer> | null = null;
const getWavetableWasmBytes = async () => {
  if (wavetableWasmBytes) {
    return wavetableWasmBytes;
  } else if (getBytesPromise) {
    return getBytesPromise;
  }

  getBytesPromise = fetch('/wavetable.wasm').then(res => res.arrayBuffer());

  const bytes = await getBytesPromise;
  wavetableWasmBytes = bytes;

  // Lazily initialize the wavetable instance as well
  if (wavetableWasmInstance === undefined) {
    wavetableWasmInstance = null;
    setTimeout(getWavetableWasmInstance);
  }

  return bytes;
};

let wavetableWasmInstance: WebAssembly.Instance | undefined | null;
export const getWavetableWasmInstance = async () => {
  if (wavetableWasmInstance) {
    return wavetableWasmInstance;
  }

  const bytes = await getWavetableWasmBytes();
  const mod = await WebAssembly.compile(bytes);
  const inst = await WebAssembly.instantiate(mod);
  wavetableWasmInstance = inst;
  return wavetableWasmInstance;
};
export const getWavetableWasmInstancePreloaded = () => {
  if (!wavetableWasmInstance) {
    throw new UnreachableException('Tried to access wavetable Wasm instance before it was loaded');
  }
  return wavetableWasmInstance;
};

export default class WaveTable implements ForeignNode {
  private ctx: AudioContext;
  private vcId: string;
  public workletHandle: AudioWorkletNode | undefined;
  private wavetableDef: Float32Array[][] = getDefaultWavetableDef();
  private onInitialized?: (inst: WaveTable) => void;

  static typeName = 'Wave Table Synthesizer';
  public nodeType = 'customAudio/wavetable';

  public paramOverrides: {
    [name: string]: { param: OverridableAudioParam; override: ConstantSourceNode };
  } = {};

  constructor(ctx: AudioContext, vcId: string, params?: { [key: string]: any } | null) {
    this.ctx = ctx;
    this.vcId = vcId;

    if (params?.wavetableDef) {
      this.wavetableDef = params.wavetableDef;
    }

    if (params?.onInitialized) {
      this.onInitialized = params.onInitialized;
    }

    this.initWorklet().then(workletHandle => {
      this.paramOverrides = this.buildParamOverrides(workletHandle);

      if (params) {
        this.deserialize(params);
      }

      if (this.vcId.length > 0) {
        updateConnectables(this.vcId, this.buildConnectables());
      }

      if (this.onInitialized) {
        this.onInitialized(this);
      }
    });
  }

  private buildParamOverrides(workletHandle: AudioWorkletNode): ForeignNode['paramOverrides'] {
    // Work around incomplete TypeScript typings
    const frequencyParam = (workletHandle.parameters as Map<string, AudioParam>).get('frequency')!;
    const frequencyOverride = new OverridableAudioParam(this.ctx, frequencyParam);
    const detuneParam = (workletHandle.parameters as Map<string, AudioParam>).get('detune');
    const detuneOverride = new OverridableAudioParam(this.ctx, detuneParam, undefined, false);

    const overrides: ForeignNode['paramOverrides'] = {
      frequency: { param: frequencyOverride, override: frequencyOverride.manualControl },
      detune: { param: detuneOverride, override: detuneOverride.manualControl },
    };

    // TODO: get dimension count dynamically
    R.range(0, 2).forEach(i => {
      const intraDimensionalMixKey = `dimension_${i}_mix`;
      // Work around incomplete TypeScript typings
      const param: AudioParam = (workletHandle.parameters as Map<string, AudioParam>).get(
        intraDimensionalMixKey
      )!;
      const override = new OverridableAudioParam(this.ctx, param);

      overrides[intraDimensionalMixKey] = {
        param: override,
        override: override.manualControl,
      };

      if (i > 0) {
        const interDimensionalMixKey = `dimension_${i - 1}x${i}_mix`;
        // Work around incomplete TypeScript typings
        const param = (workletHandle.parameters as Map<string, AudioParam>).get(
          interDimensionalMixKey
        )!;
        const override = new OverridableAudioParam(this.ctx, param);

        overrides[interDimensionalMixKey] = {
          param: override,
          override: override.manualControl,
        };
      }
    });

    return overrides;
  }

  private deserialize(params: { [key: string]: any }) {
    Object.entries(params).forEach(([key, val]) => {
      if (this.paramOverrides[key]) {
        this.paramOverrides[key].override.offset.value = val;
      }
    });

    if (params.intraDimMixes) {
      (params.intraDimMixes as number[]).forEach((mix, dimIx) => {
        this.paramOverrides[`dimension_${dimIx}_mix`].override.offset.setValueAtTime(
          mix,
          this.ctx.currentTime
        );
      });
    }

    if (params.interDimMixes) {
      (params.interDimMixes as number[]).forEach((mix, i) => {
        this.paramOverrides[`dimension_${i}x${i + 1}_mix`].override.offset.setValueAtTime(
          mix,
          this.ctx.currentTime
        );
      });
    }
  }

  public serialize() {
    return Object.entries(this.paramOverrides).reduce(
      (acc, [key, val]) => ({ ...acc, [key]: val.override.offset.value }),
      {} as { [key: string]: number }
    );
  }

  private async initWaveTable() {
    const dimensionCount = this.wavetableDef.length;
    const waveformsPerDimension = this.wavetableDef[0].length;
    const samplesPerDimension = waveformLength * waveformsPerDimension;

    const tableSamples = new Float32Array(dimensionCount * waveformsPerDimension * waveformLength);
    for (let dimensionIx = 0; dimensionIx < dimensionCount; dimensionIx++) {
      for (let waveformIx = 0; waveformIx < waveformsPerDimension; waveformIx++) {
        for (let sampleIx = 0; sampleIx < waveformLength; sampleIx++) {
          tableSamples[
            samplesPerDimension * dimensionIx + waveformLength * waveformIx + sampleIx
          ] = this.wavetableDef[dimensionIx][waveformIx][sampleIx];
        }
      }
    }

    this.workletHandle!.port.postMessage({
      arrayBuffer: await getWavetableWasmBytes(),
      waveformsPerDimension,
      dimensionCount,
      waveformLength,
      baseFrequency,
      tableSamples,
    });
  }

  private async initWorklet() {
    await this.ctx.audioWorklet.addModule('/WaveTableNodeProcessor.js');
    this.workletHandle = new AudioWorkletNode(this.ctx, 'wavetable-node-processor');

    await this.initWaveTable();

    return this.workletHandle;
  }

  public buildConnectables() {
    return {
      // TODO: get dimension count dynamically
      inputs: R.range(0, 2).reduce(
        (acc, i) => {
          const newAcc = acc.set(`dimension_${i}_mix`, {
            node: this.workletHandle
              ? (this.workletHandle.parameters as any).get(`dimension_${i}_mix`)
              : new DummyNode(),
            type: 'number',
          });

          // The first dimension doesn't have any inter-dimensional mix param since it's the first one
          if (i === 0) {
            return newAcc;
          }

          return newAcc.set(`dimension_${i - 1}x${i}_mix`, {
            node: this.workletHandle
              ? (this.workletHandle.parameters as any).get(`dimension_${i - 1}x${i}_mix`)
              : new DummyNode(),
            type: 'number',
          });
        },
        Map<string, ConnectableInput>()
          .set('frequency', {
            node: this.paramOverrides.frequency
              ? this.paramOverrides.frequency.param
              : new DummyNode(),
            type: 'number',
          })
          .set('detune', {
            node: this.paramOverrides.detune ? this.paramOverrides.detune.param : new DummyNode(),
            type: 'number',
          })
      ),
      outputs: Map<string, ConnectableOutput>().set('output', {
        node: this.workletHandle ? this.workletHandle : new DummyNode(),
        type: 'customAudio',
      }),
      vcId: this.vcId,
      node: this,
    };
  }

  public shutdown() {
    this.workletHandle?.port.postMessage('shutdown');
  }
}

export const decodeWavetableDef = ({
  encodedWavetableDef,
  dimensionCount,
  waveformsPerDimension,
  samplesPerWaveform,
}: {
  encodedWavetableDef: string;
  dimensionCount: number;
  waveformsPerDimension: number;
  samplesPerWaveform: number;
}): Float32Array[][] => {
  const packed = new Float32Array(base64ToArrayBuffer(encodedWavetableDef));
  const samplesPerDimension = waveformsPerDimension * samplesPerWaveform;

  const wavetableDef: Float32Array[][] = [];
  for (let dimIx = 0; dimIx < dimensionCount; dimIx++) {
    wavetableDef.push([]);
    for (let waveformIx = 0; waveformIx < waveformsPerDimension; waveformIx++) {
      wavetableDef[dimIx].push(new Float32Array(samplesPerWaveform));
      for (let sampleIx = 0; sampleIx < samplesPerWaveform; sampleIx++) {
        wavetableDef[dimIx][waveformIx][sampleIx] =
          packed[dimIx * samplesPerDimension + waveformIx * samplesPerWaveform + sampleIx];
      }
    }
  }

  return wavetableDef;
};
