import { Component, type ReactNode } from "react";

type Props = {
  /** What failed, for the console line (`review pane`, `diff view`). */
  label: string;
  /** What to show instead of the children once one of them threw, given the error's message. */
  fallback: (message: string) => ReactNode;
  /** A change of this value clears a caught error (the next file, the other layout). */
  resetKey?: string;
  children: ReactNode;
};

type State = { message: string | null; key: string | undefined };

/** The message of anything thrown. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Keeps a failure inside one part of the UI (Story 8.1: the Review pane and its diff view): a
 * render or effect error in the children shows `fallback` in their place instead of unmounting the
 * whole app.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { message: null, key: this.props.resetKey };

  static getDerivedStateFromError(err: unknown): Partial<State> {
    return { message: errorMessage(err) };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    return props.resetKey === state.key ? null : { message: null, key: props.resetKey };
  }

  componentDidCatch(err: unknown): void {
    console.error(`${this.props.label}: ${errorMessage(err)}`);
  }

  render(): ReactNode {
    return this.state.message === null ? this.props.children : this.props.fallback(this.state.message);
  }
}
