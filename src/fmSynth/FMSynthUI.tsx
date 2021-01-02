import React, { useEffect, useState } from 'react';
import * as R from 'ramda';

import ConfigureOperator, { OperatorConfig } from './ConfigureOperator';
import './FMSynth.scss';
import { classNameIncludes } from 'src/util';
import ConfigureEffects, { Effect } from 'src/fmSynth/ConfigureEffects';
import FMSynth from 'src/graphEditor/nodes/CustomAudio/FMSynth/FMSynth';
import ModulationMatrix from 'src/fmSynth/ModulationMatrix';
import { UnreachableException } from 'ameo-utils';
import ConfigureModulationIndex from 'src/fmSynth/ConfigureModulationIndex';
import { ParamSource } from 'src/fmSynth/ConfigureParamSource';

interface FMSynthState {
  modulationMatrix: ParamSource[][];
  outputWeights: number[];
  operatorConfigs: OperatorConfig[];
  operatorEffects: (Effect | null)[][];
  mainEffectChain: (Effect | null)[];
}

type BackendModulationUpdater = (
  operatorIx: number,
  modulationIx: number,
  val: ParamSource
) => void;
type BackendOutputUpdater = (operatorIx: number, val: number) => void;

const setModulation = (
  state: FMSynthState,
  srcOperatorIx: number,
  dstOperatorIx: number,
  updateBackendModulation: BackendModulationUpdater,
  getNewVal: (prevVal: ParamSource) => ParamSource
): FMSynthState => {
  const newModulationIndices = [...state.modulationMatrix];
  newModulationIndices[srcOperatorIx] = [...newModulationIndices[srcOperatorIx]];
  newModulationIndices[srcOperatorIx][dstOperatorIx] = getNewVal(
    newModulationIndices[srcOperatorIx][dstOperatorIx]
  );
  updateBackendModulation(
    srcOperatorIx,
    dstOperatorIx,
    newModulationIndices[srcOperatorIx][dstOperatorIx]
  );
  return { ...state, modulationMatrix: newModulationIndices };
};

const setOutput = (
  state: FMSynthState,
  operatorIx: number,
  updateBackendOutput: BackendOutputUpdater,
  getNewVal: (prevVal: number) => number
): FMSynthState => {
  const newOutputWeights = [...state.outputWeights];
  newOutputWeights[operatorIx] = getNewVal(newOutputWeights[operatorIx]);
  updateBackendOutput(operatorIx, newOutputWeights[operatorIx]);
  return { ...state, outputWeights: newOutputWeights };
};

const ConfigureMainEffectChain: React.FC<{
  mainEffectChain: (Effect | null)[];
  onChange: (ix: number, newEffect: Effect | null) => void;
  setEffects: (newEffects: (Effect | null)[]) => void;
}> = ({ mainEffectChain, onChange, setEffects }) => {
  return (
    <ConfigureEffects state={mainEffectChain} onChange={onChange} setOperatorEffects={setEffects} />
  );
};

export type UISelection =
  | { type: 'mainEffectChain' }
  | { type: 'operator'; index: number }
  | { type: 'modulationIndex'; srcOperatorIx: number; dstOperatorIx: number };

const FMSynthUI: React.FC<{
  updateBackendModulation: BackendModulationUpdater;
  updateBackendOutput: BackendOutputUpdater;
  modulationMatrix: ParamSource[][];
  outputWeights: number[];
  operatorConfigs: OperatorConfig[];
  onOperatorConfigChange: (operatorIx: number, newConfig: OperatorConfig) => void;
  operatorEffects: (Effect | null)[][];
  mainEffectChain: (Effect | null)[];
  setEffect: (operatorIx: number | null, effectIx: number, effect: Effect | null) => void;
  initialSelectedUI?: UISelection | null;
  onSelectedUIChange: (newSelectedUI: UISelection | null) => void;
}> = ({
  updateBackendModulation,
  updateBackendOutput,
  modulationMatrix,
  outputWeights,
  operatorConfigs,
  onOperatorConfigChange,
  operatorEffects,
  mainEffectChain,
  setEffect,
  initialSelectedUI,
  onSelectedUIChange,
}) => {
  const [state, setState] = useState<FMSynthState>({
    modulationMatrix,
    outputWeights,
    operatorConfigs,
    operatorEffects,
    mainEffectChain,
  });
  const [selectedUI, setSelectedUIInner] = useState<UISelection | null>(initialSelectedUI ?? null);
  const setSelectedUI = (newSelectedUI: UISelection | null) => {
    onSelectedUIChange(newSelectedUI);
    setSelectedUIInner(newSelectedUI);
  };

  useEffect(() => {
    const handler = (evt: WheelEvent) => {
      const path = evt.composedPath();
      const operatorElem = path.find(elem =>
        classNameIncludes((elem as any).className, 'operator-square')
      ) as HTMLDivElement | undefined;
      if (!operatorElem) {
        return;
      }

      if (classNameIncludes(operatorElem.className, 'output-weight')) {
        const operatorIx = +operatorElem.getAttribute('data-operator-ix')!;
        setState(
          setOutput(state, operatorIx, updateBackendOutput, (prevVal: number) =>
            R.clamp(0, 1, prevVal + (evt.deltaY > 0 ? -1 : 1) * 0.01)
          )
        );
      } else {
        const srcOperatorIx = +operatorElem.getAttribute('data-src-operator-ix')!;
        const dstOperatorIx = +operatorElem.getAttribute('data-dst-operator-ix')!;
        setState(
          setModulation(
            state,
            srcOperatorIx,
            dstOperatorIx,
            updateBackendModulation,
            (prevVal: ParamSource) => {
              if (prevVal.type !== 'constant') {
                return prevVal;
              }
              return { type: 'constant', value: prevVal.value + (evt.deltaY > 0 ? -1 : 1) * 0.1 };
            }
          )
        );
      }

      evt.preventDefault();
      evt.stopPropagation();
    };

    window.addEventListener('wheel', handler, { passive: false });
    return () => window.removeEventListener('wheel', handler);
  }, [state, updateBackendModulation, updateBackendOutput]);

  const handleMainEffectChainChange = (effectIx: number, newEffect: Effect | null) => {
    const newMainEffectChain = [...state.mainEffectChain];
    newMainEffectChain[effectIx] = newEffect;
    if (!newEffect) {
      // Slide remaining effects down.  Deleting will trigger this to happen on the
      // backend as well.
      for (let i = effectIx; i < newMainEffectChain.length; i++) {
        const nextEffect = newMainEffectChain[i + 1];
        if (nextEffect) {
          newMainEffectChain[i] = nextEffect;
          newMainEffectChain[i + 1] = null;
          setEffect(null, i + 1, null);
        }
      }
    }

    setEffect(null, effectIx, newEffect);
    setState({ ...state, mainEffectChain: newMainEffectChain });
  };

  const handleEffectChange = (effectIx: number, newEffect: Effect | null) => {
    if (selectedUI?.type !== 'operator') {
      console.warn('UI invariant in handleEffectChange');
      return;
    }
    const { index: selectedOperatorIx } = selectedUI;

    setEffect(selectedOperatorIx, effectIx, newEffect);
    const newState = { ...state };
    newState.operatorEffects = [...newState.operatorEffects];
    newState.operatorEffects[selectedOperatorIx] = [
      ...newState.operatorEffects[selectedOperatorIx],
    ];
    newState.operatorEffects[selectedOperatorIx][effectIx] = newEffect;

    if (!newEffect) {
      // Slide remaining effects down.  Deleting will trigger this to happen on the backend as well.
      for (let i = effectIx; i < newState.operatorEffects[selectedOperatorIx].length; i++) {
        const nextEffect = newState.operatorEffects[selectedOperatorIx][i + 1];
        if (nextEffect) {
          newState.operatorEffects[selectedOperatorIx][i] = nextEffect;
          newState.operatorEffects[selectedOperatorIx][i + 1] = null;
          setEffect(selectedOperatorIx, i + 1, null);
        }
      }
    }

    setState(newState);
  };

  return (
    <div className='fm-synth-ui'>
      <ModulationMatrix
        selectedOperatorIx={selectedUI?.type === 'operator' ? selectedUI.index : null}
        onOperatorSelected={(newSelectedOperatorIx: number) =>
          setSelectedUI({ type: 'operator', index: newSelectedOperatorIx })
        }
        onModulationIndexSelected={(srcOperatorIx: number, dstOperatorIx: number) =>
          setSelectedUI({ type: 'modulationIndex', srcOperatorIx, dstOperatorIx })
        }
        modulationIndices={state.modulationMatrix}
        outputWeights={state.outputWeights}
        selectedUI={selectedUI}
      />
      <div
        className='main-effect-chain-selector'
        data-active={selectedUI?.type === 'mainEffectChain' ? 'true' : 'false'}
        onClick={() => setSelectedUI({ type: 'mainEffectChain' })}
      >
        MAIN EFFECT CHAIN
      </div>

      {selectedUI?.type === 'mainEffectChain' ? (
        <ConfigureMainEffectChain
          mainEffectChain={state.mainEffectChain}
          onChange={handleMainEffectChainChange}
          setEffects={(newEffects: (Effect | null)[]) => {
            newEffects.forEach((effect, effectIx) => setEffect(null, effectIx, effect));
            setState({ ...state, mainEffectChain: newEffects });
          }}
        />
      ) : null}
      {selectedUI?.type === 'operator'
        ? (() => {
            const selectedOperatorIx = selectedUI.index;

            return (
              <ConfigureOperator
                config={state.operatorConfigs[selectedOperatorIx]}
                onChange={newConf => {
                  setState({
                    ...state,
                    operatorConfigs: R.set(
                      R.lensIndex(selectedOperatorIx),
                      newConf,
                      state.operatorConfigs
                    ),
                  });
                  onOperatorConfigChange(selectedOperatorIx, newConf);
                }}
                effects={state.operatorEffects[selectedOperatorIx]}
                onEffectsChange={handleEffectChange}
                setEffects={newEffects => {
                  newEffects.forEach((effect, effectIx) =>
                    setEffect(selectedOperatorIx, effectIx, effect)
                  );
                  setState({
                    ...state,
                    operatorEffects: R.set(
                      R.lensIndex(selectedOperatorIx),
                      newEffects,
                      state.operatorEffects
                    ),
                  });
                }}
              />
            );
          })()
        : null}
      {selectedUI?.type === 'modulationIndex' ? (
        <ConfigureModulationIndex
          srcOperatorIx={selectedUI.srcOperatorIx}
          dstOperatorIx={selectedUI.dstOperatorIx}
          modulationIndices={state.modulationMatrix}
          onChange={(
            srcOperatorIx: number,
            dstOperatorIx: number,
            newModulationIndex: ParamSource
          ) =>
            setState(
              setModulation(
                state,
                srcOperatorIx,
                dstOperatorIx,
                updateBackendModulation,
                (_prevVal: ParamSource) => newModulationIndex
              )
            )
          }
        />
      ) : null}
    </div>
  );
};

export const ConnectedFMSynthUI: React.FC<{ synth: FMSynth }> = ({ synth }) => (
  <FMSynthUI
    updateBackendModulation={(srcOperatorIx: number, dstOperatorIx: number, val: ParamSource) =>
      synth.handleModulationIndexChange(srcOperatorIx, dstOperatorIx, val)
    }
    updateBackendOutput={(operatorIx: number, val: number) =>
      synth.handleOutputWeightChange(operatorIx, val)
    }
    modulationMatrix={synth.getModulationMatrix()}
    outputWeights={synth.getOutputWeights()}
    operatorConfigs={synth.getOperatorConfigs()}
    onOperatorConfigChange={(operatorIx: number, newOperatorConfig: OperatorConfig) =>
      synth.handleOperatorConfigChange(operatorIx, newOperatorConfig)
    }
    operatorEffects={synth.getOperatorEffects()}
    mainEffectChain={synth.getMainEffectChain()}
    setEffect={synth.setEffect.bind(synth)}
    initialSelectedUI={synth.selectedUI}
    onSelectedUIChange={newSelectedUI => {
      synth.selectedUI = newSelectedUI;
    }}
  />
);

export default FMSynthUI;
