cd engine && cargo build --target wasm32-unknown-unknown --release && \
  cd ../midi && cargo build --target wasm32-unknown-unknown --release && \
  cd ../polysynth && cargo build --target wasm32-unknown-unknown --release --features wasm-bindgen-exports && \
  cd ../spectrum_viz && cargo build --target wasm32-unknown-unknown --release && \
  cd ../wavetable && cargo build --target wasm32-unknown-unknown --release && \
  cd ../waveform_renderer && cargo build --target wasm32-unknown-unknown --release
