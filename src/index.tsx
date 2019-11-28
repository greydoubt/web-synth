import * as React from 'react';
import * as ReactDOM from 'react-dom';
import { Provider } from 'react-redux';

const wasm = import('./engine');
import { actionCreators, dispatch, store, getState } from './redux';
import { ViewContextManager, ViewContextSwitcher } from './ViewContextManager';
import { commitForeignConnectables } from 'src/redux/modules/viewContextManager';
import { tryParseJson } from 'src/util';
import { ConnectableDescriptor } from 'src/patchNetwork';

let engineHandle: typeof import('./engine');

export const getEngine = (): typeof import('./engine') | undefined => engineHandle;

const createViewContextManager = (engine: typeof import('./engine')) => {
  ReactDOM.render(
    <Provider store={store}>
      <ViewContextManager engine={engine} />
    </Provider>,
    document.getElementById('view-context-manager')
  );

  ReactDOM.render(
    <Provider store={store}>
      <ViewContextSwitcher engine={engine} />
    </Provider>,
    document.getElementById('view-context-switcher')
  );
};

// TODO: Figure out if this is actually used
export const init_view_contexts = (
  activeViewContextIx: number,
  activeVcsJson: string,
  connectionsJson: string,
  foreignConnectablesJson: string
): void => {
  const activeViewContexts = tryParseJson<
    {
      minimal_def: { name: string; uuid: string; title?: string };
    }[]
  >(activeVcsJson, [], 'Failed to parse JSON of `activeViewContexts`; clearing all view contexts');

  const connections = tryParseJson<[ConnectableDescriptor, ConnectableDescriptor][]>(
    connectionsJson,
    [],
    'Failed to parse provided connections out of JSON'
  );

  const foreignConnectables = tryParseJson<{ type: string; id: string; serializedState: string }[]>(
    foreignConnectablesJson,
    [],
    'Failed to parse foreign nodes JSON; using an empty list but that will probably create invalid connections.'
  );

  dispatch(actionCreators.viewContextManager.SET_IS_LOADED(false));
  dispatch(
    actionCreators.viewContextManager.SET_VCM_STATE(
      {
        activeViewContextIx,
        activeViewContexts: activeViewContexts.map(({ minimal_def, ...rest }) => ({
          ...minimal_def,
          ...rest,
        })),
        foreignConnectables,
      },
      connections
    )
  );
};

export const add_view_context = (id: string, name: string) => {
  const engine = getEngine()!; // Must exist because this gets called *from the engine*.
  dispatch(actionCreators.viewContextManager.ADD_VIEW_CONTEXT(id, name));
  dispatch(
    actionCreators.viewContextManager.ADD_PATCH_NETWORK_NODE(id, engine.get_vc_connectables(id))
  );
};

export const delete_view_context = (id: string) => {
  dispatch(actionCreators.viewContextManager.REMOVE_PATCH_NETWORK_NODE(id));
  dispatch(actionCreators.viewContextManager.DELETE_VIEW_CONTEXT(id));
};

export const set_active_vc_ix = (newActiveVxIx: number) =>
  dispatch(actionCreators.viewContextManager.SET_ACTIVE_VC_IX(newActiveVxIx));

wasm.then(engine => {
  engineHandle = engine;
  engine.init();

  window.addEventListener('beforeunload', () => {
    // Commit the whole patch network's foreign connectables, serializing + saving their state in the process
    commitForeignConnectables(
      engine,
      getState().viewContextManager.patchNetwork.connectables.filter(({ node }) => !!node)
    );

    // Cleanup all VCs and save their state
    engine.handle_window_close();
  });

  createViewContextManager(engine);
});
