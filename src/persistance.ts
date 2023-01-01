import Dexie from 'dexie';
import download from 'downloadjs';
import { Either } from 'funfix-core';

import { getLoadedComposition } from 'src/api';
import type { CompositionDefinition } from 'src/compositionSharing/CompositionSharing';
import { stopAll } from 'src/eventScheduler/eventScheduler';
import { setGlobalBpm } from 'src/globalMenu';
import { actionCreators, dispatch, getState } from 'src/redux';
import { commitForeignConnectables } from 'src/redux/modules/vcmUtils';

export const serializeAndDownloadComposition = () => {
  download(JSON.stringify(localStorage), 'composition.json', 'application/json');
};

/**
 * Resets the current state of the application, tearing down + cleaning up all modules and VCs and re-initializes
 * with the provided composition.
 */
export const reinitializeWithComposition = (
  compositionBody:
    | { type: 'serialized'; value: string }
    | { type: 'parsed'; value: { [key: string]: string } },
  engine: typeof import('./engine'),
  allViewContextIds: string[]
): Either<string, void> => {
  let deserialized: { [key: string]: string };
  if (compositionBody.type === 'serialized') {
    try {
      deserialized = JSON.parse(compositionBody.value);
    } catch (err) {
      return Either.left('Failed to parse provided JSON');
    }
  } else {
    deserialized = compositionBody.value;
  }

  // Stop any playback
  stopAll();

  // Tear down current application state
  allViewContextIds.forEach(engine.delete_vc_by_id);
  getState().viewContextManager.patchNetwork.connectables.forEach(connectable => {
    dispatch(actionCreators.viewContextManager.REMOVE_PATCH_NETWORK_NODE(connectable.vcId));
  });

  // Rehydrate `localStorage` with parsed composition
  Object.entries(deserialized).forEach(([key, val]) => localStorage.setItem(key, val));

  // Trigger applicaion to refresh using the newly set `localStorage` content
  engine.init();

  return Either.right(void 0);
};

const localCompDbClient = new Dexie('savedLocalComposition');
localCompDbClient.version(1).stores({
  localComposition: '',
  currentLoadedCompositionId: '',
});
const localCompositionTable = localCompDbClient.table('localComposition');
const currentLoadedCompositionIdTable = localCompDbClient.table('currentLoadedCompositionId');

export const onBeforeUnload = (engine: typeof import('src/engine')) => {
  // Commit the whole patch network's foreign connectables, serializing + saving their state in the process
  commitForeignConnectables(
    engine,
    getState().viewContextManager.patchNetwork.connectables.filter(({ node }) => !!node)
  );

  // Cleanup all VCs and save their state
  engine.handle_window_close();
};

/**
 * Populates localstorage with the contents of the provided composition.  This function does NOT handle
 * re-initializing the application, destroying + recreacting VCs, etc. and is designed to be used before the
 * application is first loaded.
 */
export const loadSharedComposition = async (
  composition: CompositionDefinition,
  force?: boolean,
  retainLocalStorage?: boolean
) => {
  // If we already have a local composition saved in the DB, we don't want to overwrite it.
  const hasSavedLocalComposition = (await localCompositionTable.count()) > 0;
  if (!hasSavedLocalComposition) {
    const serialized = JSON.stringify(localStorage);
    await localCompositionTable.add(serialized, ['']);
  }

  // If the shared composition is already loaded, we will use whatever forked version the user
  // has locally rather than refresh again.
  const [prevLoadedCompId] = await currentLoadedCompositionIdTable.toArray();
  if (prevLoadedCompId === composition.id && !force) {
    console.log('Loaded comp id matches existing; not refreshing from scratch');
    return;
  }

  await currentLoadedCompositionIdTable.clear();
  await currentLoadedCompositionIdTable.add(composition.id, ['']);

  const deserialized = JSON.parse(composition.content);
  const keysToRetain = ['globalVolume'];
  const retainedValues = keysToRetain.map(key => [key, localStorage.getItem(key)]);
  if (!retainLocalStorage) {
    localStorage.clear();
  }
  Object.entries(deserialized)
    .filter(([key]) => !keysToRetain.includes(key))
    .forEach(([key, val]) => localStorage.setItem(key, val as any));
  retainedValues.forEach(([key, val]) => {
    if (key && val !== null && val !== undefined) {
      localStorage.setItem(key, val as any);
    }
  });

  if (
    typeof deserialized.globalTempo === 'string' ||
    typeof deserialized.globalTempo === 'number'
  ) {
    setGlobalBpm(+deserialized.globalTempo);
  }
};

export const maybeRestoreLocalComposition = async () => {
  const hasSavedLocalComposition = (await localCompositionTable.count()) > 0;
  if (!hasSavedLocalComposition) {
    return;
  }

  const [serializedSavedComp] = await currentLoadedCompositionIdTable.toArray();
  const savedComp = JSON.parse(serializedSavedComp);
  localStorage.clear();
  Object.entries(savedComp).forEach(([key, val]) => localStorage.setItem(key, val as any));

  await currentLoadedCompositionIdTable.clear();
  await localCompositionTable.clear();
};

/**
 * Fetches the shared composition with the provided ID, deserializes it, and populates localstorage with its contents.
 * This function does NOT handle re-initializing the application, destroying + recreacting VCs, etc. and is designed
 * to be used before the application is first loaded.
 */
export const fetchAndLoadSharedComposition = async (
  compositionID: string | number,
  force?: boolean,
  retainLocalStorage?: boolean
) => {
  console.log(`Loading composition id=${compositionID}`);

  const composition = await getLoadedComposition(compositionID);
  if (!composition) {
    console.error(`Failed to load composition id=${compositionID}; not found?`);
    return;
  }
  await loadSharedComposition(composition, force, retainLocalStorage);
};
