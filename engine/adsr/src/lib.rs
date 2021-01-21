#![feature(box_syntax, get_mut_unchecked)]

use std::rc::Rc;

use dsp::even_faster_pow;

extern "C" {
    pub fn debug1(v1: f32, v2: f32, v3: f32);
}

const SAMPLE_RATE: usize = 44_100;
pub const RENDERED_BUFFER_SIZE: usize = SAMPLE_RATE;
const FRAME_SIZE: usize = 128;

#[derive(Clone, Copy)]
pub enum RampFn {
    Instant,
    Linear,
    Exponential { exponent: f32 },
}

impl RampFn {
    pub fn from_u32(type_val: u32, param: f32) -> Self {
        match type_val {
            0 => Self::Instant,
            1 => Self::Linear,
            2 => Self::Exponential { exponent: param },
            _ => panic!("Invlaid ramper fn type: {}", type_val),
        }
    }
}

fn compute_pos(prev_step: &AdsrStep, next_step: &AdsrStep, phase: f32) -> f32 {
    match next_step.ramper {
        RampFn::Instant => prev_step.y,
        RampFn::Linear => {
            let y_diff = next_step.y - prev_step.y;
            let distance = next_step.x - prev_step.x;
            let pct_complete = (phase - prev_step.x) / distance;
            prev_step.y + pct_complete * y_diff
        },
        RampFn::Exponential { exponent } => {
            let y_diff = next_step.y - prev_step.y;
            let distance = next_step.x - prev_step.x;
            let x = (phase - prev_step.x) / distance;
            // prev_step.y + x.powf(exponent) * y_diff
            prev_step.y + even_faster_pow(x, exponent) * y_diff
        },
    }
}

#[derive(Clone, Copy)]
pub struct AdsrStep {
    pub x: f32,
    pub y: f32,
    pub ramper: RampFn,
}

#[derive(Clone, Copy, PartialEq)]
pub enum GateStatus {
    Gated,
    /// We have progressed through the envelope and reached the release point.  No loop point was
    /// provided, and the output value at that instant has been locked in.  The output buffer has
    /// been pre-filled with that value, so rendering is not required until afer the ADSR is
    /// un-gated and the release is triggered.
    GatedFrozen,
    Releasing,
    /// The ADSR has been released and reached the end of its phase.  The output buffer has been
    /// filled with the final output value, and further rendering is not required.
    Done,
}

#[derive(Clone)]
pub struct Adsr {
    /// From 0 to 1 representing position in the ADSR from start to end
    pub phase: f32,
    pub gate_status: GateStatus,
    /// Point at which the decay begins.
    pub release_start_phase: f32,
    steps: Vec<AdsrStep>,
    /// If provided, once the ADSR hits point `release_start_phase`, it will loop back to
    /// `loop_point` until it is released.
    loop_point: Option<f32>,
    /// Contains the rendered waveform the for ADSR from start to end, used as an optimization to
    /// avoid having to compute ramp points every sample
    rendered: Rc<[f32; RENDERED_BUFFER_SIZE]>,
    /// A buffer into which the current output for the ADSR is rendered each frame
    cur_frame_output: Box<[f32; FRAME_SIZE]>,
    len_samples: f32,
    /// Optimization to avoid having to do some math in the hot path.  Always should be equal to
    /// `(1 / len_samples) `
    cached_phase_diff_per_sample: f32,
    /// If set, whenever the ADSR is updated, the most recent phase will be written to this
    /// pointer.  This is used to facilitate rendering of ADSRs in the UI by sharing some memory
    /// containing the current phase of all active ADSRs.
    pub store_phase_to: Option<*mut f32>,
}

const DEFAULT_FIRST_STEP: AdsrStep = AdsrStep {
    x: 0.,
    y: 0.,
    ramper: RampFn::Instant,
};

impl Adsr {
    pub fn new(
        steps: Vec<AdsrStep>,
        loop_point: Option<f32>,
        len_samples: f32,
        release_start_phase: f32,
        rendered: Rc<[f32; RENDERED_BUFFER_SIZE]>,
    ) -> Self {
        Adsr {
            phase: 0.,
            gate_status: GateStatus::Done,
            release_start_phase,
            steps,
            loop_point,
            rendered,
            cur_frame_output: box unsafe { std::mem::MaybeUninit::uninit().assume_init() },
            len_samples,
            cached_phase_diff_per_sample: (1. / len_samples),
            store_phase_to: None,
        }
    }

    pub fn gate(&mut self) {
        self.phase = 0.;
        self.gate_status = GateStatus::Gated;
    }

    pub fn ungate(&mut self) {
        self.phase = self.release_start_phase;
        self.gate_status = GateStatus::Releasing;
    }

    /// Renders the ADSR into the shared buffer.  Only needs to be called once for all ADSRs that
    /// share this associated buffer.
    pub fn render(&mut self) {
        let mut prev_step_opt: Option<&AdsrStep> = None;
        let mut next_step_opt: Option<&AdsrStep> = self.steps.get(0);
        let mut next_step_ix = 0usize;
        let buf = unsafe { Rc::get_mut_unchecked(&mut self.rendered) };

        for i in 0..RENDERED_BUFFER_SIZE {
            let phase = i as f32 / RENDERED_BUFFER_SIZE as f32;

            // Check to see if we've reached past the `next_step` and move through the steps if so
            while let Some(next_step) = next_step_opt.as_mut() {
                // Still not past it
                if next_step.x >= phase {
                    break;
                }

                next_step_ix += 1;
                prev_step_opt = Some(*next_step);
                next_step_opt = self.steps.get(next_step_ix);
            }

            let next_step = match next_step_opt.as_mut() {
                Some(step) => step,
                None => {
                    // If there are no more steps and an end step isn't provided, we just hold the
                    // value from the last step we have
                    buf[i] = prev_step_opt.map(|step| step.y).unwrap_or(0.);
                    continue;
                },
            };

            let prev_step = prev_step_opt.unwrap_or(&DEFAULT_FIRST_STEP);
            buf[i] = compute_pos(prev_step, next_step, phase);
        }
    }

    pub fn set_len_samples(&mut self, new_len_samples: f32) {
        self.len_samples = new_len_samples;
        self.cached_phase_diff_per_sample = 1. / new_len_samples;
    }

    /// Advance phase by one sample's worth
    ///
    /// TODO: Fastpath this if we are not close to hitting the decay point (if gated )or the end of
    /// the waveform (if released)
    fn advance_phase(&mut self) {
        self.phase = (self.phase + self.cached_phase_diff_per_sample).min(1.);

        // We are gating and have crossed the release point
        if self.gate_status == GateStatus::Gated && self.phase >= self.release_start_phase {
            if let Some(loop_start) = self.loop_point {
                let overflow_amount = self.phase - self.release_start_phase;
                let loop_size = self.release_start_phase - loop_start;
                self.phase = loop_start + (overflow_amount / loop_size).trunc();
            } else {
                // Lock our phase to the release point if we're still gated.  Transitioning to
                // `GateStatus::GatedFrozen` is handled in `render_frame()`.
                self.phase = self.release_start_phase;
            }
        }
    }

    /// Advance the ADSR state by one sample worth and return the output for the current sample
    fn get_sample(&mut self) -> f32 {
        self.advance_phase();

        debug_assert!(self.phase >= 0. && self.phase <= 1.);
        dsp::read_interpolated(
            &*self.rendered,
            self.phase * (RENDERED_BUFFER_SIZE - 2) as f32,
        )
    }

    fn maybe_write_cur_phase(&self) {
        if let Some(write_to_ptr) = self.store_phase_to {
            unsafe { std::ptr::write(write_to_ptr, self.phase) };
        }
    }

    /// Populates `self.cur_frame_output` with samples for the current frame
    pub fn render_frame(&mut self) {
        match self.gate_status {
            GateStatus::Gated
                if self.loop_point.is_none() && self.phase >= self.release_start_phase =>
            {
                // No loop point, so we freeze the output value and avoid re-rendering until after
                // ungating
                let frozen_output = self.get_sample();
                for i in 0..FRAME_SIZE {
                    self.cur_frame_output[i] = frozen_output;
                }
                self.gate_status = GateStatus::GatedFrozen;
                self.maybe_write_cur_phase();
                return;
            }
            GateStatus::Releasing if self.phase >= 1. => {
                // If we are done, we output our final value forever and freeze the output buffer,
                // not requiring any further rendering until we are re-gated
                let last_output = self.rendered[self.rendered.len() - 1];
                for i in 0..FRAME_SIZE {
                    self.cur_frame_output[i] = last_output;
                }
                self.gate_status = GateStatus::Done;
            },
            GateStatus::GatedFrozen | GateStatus::Done => {
                self.maybe_write_cur_phase();
                return;
            },
            _ => (),
        }

        for i in 0..FRAME_SIZE {
            self.cur_frame_output[i] = self.get_sample();
        }
        self.maybe_write_cur_phase();
    }

    pub fn get_cur_frame_output(&self) -> &[f32; FRAME_SIZE] { &self.cur_frame_output }

    pub fn set_loop_point(&mut self, new_loop_point: Option<f32>) {
        self.loop_point = new_loop_point;
        // TODO: Do we need to adjust gate status here if we're gated when this happens??  Almost
        // certainly, perhaps other situations as well
    }

    /// After setting steps, the shared buffer must be re-rendered.
    pub fn set_steps(&mut self, new_steps: Vec<AdsrStep>) { self.steps = new_steps; }
}
