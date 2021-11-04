use std::collections::HashMap;

use crate::{
    models::waveform::Waveform,
    schema::{synth_presets, voice_presets},
};

#[derive(Serialize, Deserialize)]
pub struct SynthPreset {
    pub voices: Vec<VoiceDefinition>,
}

#[derive(Serialize, Deserialize)]
pub struct InlineSynthPreset {
    pub voices: Vec<VoiceDefinition>,
}

#[derive(Serialize, Deserialize)]
pub enum SynthType {
    #[serde(rename = "sine")]
    Sine,
    #[serde(rename = "square")]
    Square,
    #[serde(rename = "sawtooth")]
    Sawtooth,
    #[serde(rename = "triangle")]
    Triangle,
    #[serde(rename = "fm")]
    Fm,
}

#[derive(Serialize, Deserialize)]
pub struct WavetableSettings {
    // TODO?
}

// Lowpass = 'lowpass',
// LP4 = 'order 4 lowpass',
// LP8 = 'order 8 lowpass',
// LP16 = 'order 16 lowpass',
// Highpass = 'highpass',
// HP4 = 'order 4 highpass',
// HP8 = 'order 8 highpass',
// HP16 = 'order 16 highpass',
// Bandpass = 'bandpass',
// Lowshelf = 'lowshelf',
// Highshelf = 'highshelf',
// Peaking = 'peaking',
// Notch = 'notch',
// Allpass = 'allpass',
#[derive(Serialize, Deserialize)]
pub enum FilterType {
    #[serde(rename = "lowpass")]
    Lowpass,
    #[serde(rename = "order 4 lowpass")]
    LP4,
    #[serde(rename = "order 8 lowpass")]
    LP8,
    #[serde(rename = "order 16 lowpass")]
    LP16,
    #[serde(rename = "highpass")]
    Highpass,
    #[serde(rename = "order 4 highpass")]
    HP4,
    #[serde(rename = "order 8 highpass")]
    HP8,
    #[serde(rename = "order 16 highpass")]
    HP16,
    #[serde(rename = "bandpass")]
    Bandpass,
    #[serde(rename = "lowshelf")]
    Lowshelf,
    #[serde(rename = "highshelf")]
    Highshelf,
    #[serde(rename = "peaking")]
    Peaking,
    #[serde(rename = "notch")]
    Notch,
    #[serde(rename = "allpass")]
    Allpass,
}

// export interface FilterParams {
//     type: FilterType;
//     frequency: number;
//     Q?: number;
//     gain: number;
//     detune: number;
// }
#[derive(Serialize, Deserialize)]
pub struct FilterParams {
    #[serde(rename = "type")]
    pub filter_type: FilterType,
    pub frequency: f64,
    #[serde(rename = "Q")]
    pub q: Option<f64>,
    #[serde(default)]
    pub gain: f64,
    pub detune: f64,
}

// export enum EffectType {
//   Bitcrusher = 'bitcrusher',
//   Distortion = 'distortion',
//   Reverb = 'reverb',
// }
#[derive(Serialize, Deserialize)]
pub enum EffectType {
    #[serde(rename = "bitcrusher")]
    Bitcrusher,
    #[serde(rename = "distortion")]
    Distortion,
    #[serde(rename = "reverb")]
    Reverb,
}

// export interface ADSRValue {
//   // Number [0,1] indicating how far the level is from the left to the right
//   pos: number;
//   // Number [0,1] indicating at what level the value is from the bottom to the top
//   magnitude: number;
// }
#[derive(Serialize, Deserialize)]
pub struct ADSRValue {
    pub pos: f32,
    pub magnitude: f32,
}

// export interface ADSRValues {
//   attack: ADSRValue;
//   decay: ADSRValue;
//   release: ADSRValue;
// }
#[derive(Serialize, Deserialize)]
pub struct ADSRValues {
    pub attack: ADSRValue,
    pub decay: ADSRValue,
    pub release: ADSRValue,
}

fn default_pitch_multiplier() -> f32 { 1. }

// export interface AudioThreadData {
//     /**
//      * The shared memory buffer between this thread and the audio thread.
//      */
//     buffer?: Float32Array;
//     /**
//      * The index of `buffer` at which the envelope's current phase is stored and updated
//      */
//     phaseIndex: number;
// }
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioThreadData {
    buffer: Option<Vec<f32>>,
    phase_index: usize,
}

// export type RampFn =
//   | { type: 'linear' }
//   | { type: 'instant' }
//   | { type: 'exponential'; exponent: number };
#[derive(Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum RampFn {
    #[serde(rename = "linear")]
    Linear,
    #[serde(rename = "instant")]
    Instant,
    #[serde(rename = "exponential")]
    Exponential { exponent: f32 },
}

// export interface AdsrStep {
//     x: number;
//     y: number;
//     ramper: RampFn;
// }
#[derive(Serialize, Deserialize)]
pub struct AdsrStep {
    x: f32,
    y: f32,
    ramper: RampFn,
}

// export interface Adsr {
//     steps: AdsrStep[];
//     lenSamples: number;
//     loopPoint: number | null;
//     releasePoint: number;
//     audioThreadData: AudioThreadData;
// }
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Adsr {
    steps: Vec<AdsrStep>,
    len_samples: f32,
    loop_point: Option<usize>,
    release_point: f32,
    audio_thread_data: AudioThreadData,
}

// {
//   type: FilterType;
//   frequency: number;
//   Q?: number;
//   gain: number;
//   detune: number;
// };
#[derive(Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum VoiceDefinition {
    // {
    //     unison: number;
    //     waveform: Waveform;
    //     detune: number;
    //     filter: {
    //       type: FilterType;
    //       frequency: number;
    //       Q?: number;
    //       gain: number;
    //       detune: number;
    //     };
    //     masterGain: number;
    //     selectedEffectType: EffectType;
    //     gainEnvelope: ADSRValues;
    //     gainADSRLength: number;
    //     filterEnvelope: ADSRValues;
    //     filterADSRLength: number;
    //     pitchMultiplier: number;
    // }
    #[serde(rename = "standard")]
    #[serde(rename_all = "camelCase")]
    Standard {
        unison: usize,
        waveform: SynthType,
        detune: f32,
        fm_synth_config: serde_json::Value,
        filter: FilterParams,
        master_gain: f32,
        selected_effect_type: EffectType,
        gain_envelope: ADSRValues,
        #[serde(rename = "gainADSRLength")]
        gain_adsr_length: f32,
        filter_envelope: Adsr,
        #[serde(rename = "filterADSRLength")]
        filter_adsr_length: f32,
        #[serde(default = "default_pitch_multiplier")]
        pitch_multiplier: f32,
        #[serde(default)]
        unison_spread_cents: f32,
    },
    #[serde(rename = "wavetable")]
    #[serde(rename_all = "camelCase")]
    Wavetable {
        settings: WavetableSettings,
        dimensions: Vec<Waveform>,
        mixes: Vec<f32>,
        // TODO
    },
}

pub enum Effect {
    Reverb {
        intensity: f32,
    },
    Delay {
        duration_samples: f32,
    },
    Distortion {
        intensity: f32,
    },
    Faust {
        module_id: String,
        params: HashMap<String, serde_json::Value>,
    },
}

#[derive(Serialize)]
pub struct SynthPresetEntry {
    pub id: i64,
    pub title: String,
    pub description: String,
    pub body: SynthPreset,
}

#[derive(Serialize)]
pub struct InlineSynthPresetEntry {
    pub id: i64,
    pub title: String,
    pub description: String,
    pub body: InlineSynthPreset,
}

#[derive(Deserialize)]
pub struct ReceivedSynthPresetEntry {
    pub title: String,
    pub description: String,
    pub body: SynthPreset,
}

#[derive(Insertable)]
#[table_name = "synth_presets"]
pub struct NewSynthPresetEntry {
    pub title: String,
    pub description: String,
    pub body: String,
}

#[derive(Serialize, Deserialize)]
pub struct SynthVoicePresetEntry {
    pub id: i64,
    pub title: String,
    pub description: String,
    pub body: VoiceDefinition,
}

#[derive(Deserialize)]
pub struct UserProvidedNewSynthVoicePreset {
    pub title: String,
    pub description: String,
    pub body: VoiceDefinition,
}

#[derive(Insertable)]
#[table_name = "voice_presets"]
pub struct NewSynthVoicePresetEntry {
    pub title: String,
    pub description: String,
    pub body: String,
}
