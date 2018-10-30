import * as R from 'ramda';
import Master from 'tone/Tone/core/Master';
import Synth from 'tone/Tone/instrument/Synth';
import PolySynth from 'tone/Tone/instrument/PolySynth';
import BitCrusher from 'tone/Tone/effect/BitCrusher';
import * as tonal from 'tonal';

const bitcrusher = new BitCrusher(5).toMaster();

export const createSynth = () => new PolySynth(50, Synth).toMaster();

export const synth = createSynth();
(window as any).SYNTH = synth;
(window as any).tonal = tonal;
(window as any).BITCRUSHER = bitcrusher;

Master.volume.value = -24;
