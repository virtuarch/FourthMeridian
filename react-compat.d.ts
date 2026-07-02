/**
 * react-compat.d.ts
 *
 * Compatibility shim: react-markdown@8 references the global `JSX` namespace
 * (JSX.Element, JSX.IntrinsicElements) which React 19 removed in favour of
 * React.JSX. Re-export the React 19 types under the legacy global namespace
 * so react-markdown@8's complex-types.ts compiles without errors.
 *
 * This file can be removed if react-markdown is upgraded to v9+.
 */
import 'react';

declare global {
  namespace JSX {
    type Element           = React.JSX.Element;
    type IntrinsicElements = React.JSX.IntrinsicElements;
    type ElementType       = React.JSX.ElementType;
  }
}
