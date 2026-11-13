/**
 * Whether the Model screen's form starts open. A saved model with nothing to fix is the common visit,
 * and the model's status and Test connection are what the page is for then (#129). It stays open
 * whenever the form holds what the user has to change, and whenever the page asks for the API key,
 * which the links point at as `#api-key`.
 */
export interface FormOpenState {
  /** The Workspace has a saved model, so there is something to leave alone. */
  hasModel: boolean;
  /** The saved model's key can't be read, so the form is where the key goes. */
  unreadableKey: boolean;
  /** The last save was refused, and the form carries what to fix. */
  refused: boolean;
  /** The save left the key behind, and the notice asks for the new model's key. */
  keyLeftBehind: boolean;
  /** The test that just ran found the saved key unreadable. */
  unreadableKeyTest: boolean;
}

export const formOpens = (state: FormOpenState) =>
  !state.hasModel || state.refused || state.unreadableKey || state.keyLeftBehind || state.unreadableKeyTest;
