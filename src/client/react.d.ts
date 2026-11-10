// Zero-dependency development declarations for the host-provided classic React runtime.
// This deliberately describes only the surface consumed by this client, not all of React.
declare module 'react' {
  namespace React {
    type ReactNode = ReactElement | string | number | boolean | null | undefined | readonly ReactNode[];
    interface ReactElement { type: unknown; props: unknown; key?: string | number }
    interface SyntheticEvent<T = HTMLElement> { target: T; currentTarget: T; preventDefault(): void; stopPropagation(): void; defaultPrevented: boolean }
    interface MouseEvent<T = HTMLElement> extends SyntheticEvent<T> { button: number; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }
    interface KeyboardEvent<T = HTMLElement> extends SyntheticEvent<T> { key: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }
    interface ChangeEvent<T = HTMLInputElement> extends SyntheticEvent<T> {}
    interface FormEvent<T = HTMLFormElement> extends SyntheticEvent<T> {}
    type CSSProperties = Record<string, string | number | undefined>;
    type ComponentType<P = any> = (props: P) => ReactNode;
    type SetStateAction<S> = S | ((previous: S) => S);
    type Dispatch<A> = (value: A) => void;
    interface MutableRefObject<T> { current: T }
    interface Context<T> { Provider: ComponentType<{ value: T; children?: ReactNode }>; Consumer: ComponentType<any> }
    function createElement(type: any, props?: any, ...children: ReactNode[]): ReactElement;
    const Fragment: ComponentType<{ children?: ReactNode }>;
    function useState<S = any>(initial?: S | (() => S)): [S, Dispatch<SetStateAction<S>>];
    function useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void;
    function useLayoutEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void;
    function useCallback<T extends (...args: any[]) => any>(callback: T, deps: readonly unknown[]): T;
    function useMemo<T>(factory: () => T, deps: readonly unknown[]): T;
    function useRef<T = any>(initial: T): MutableRefObject<T>;
    function useReducer<S, A>(reducer: (state: S, action: A) => S, initial: S): [S, Dispatch<A>];
    function useContext<T>(context: Context<T>): T;
    function createContext<T>(initial: T): Context<T>;
    function forwardRef<P = any, T = any>(render: (props: P, ref: MutableRefObject<T>) => ReactNode): ComponentType<P>;
    function memo<P>(component: ComponentType<P>): ComponentType<P>;
    function useId(): string;
  }
  export = React;
}

// Defensive declaration for editors that infer the automatic JSX runtime even
// though the project builds with the classic transform. The bundle never imports it.
declare module 'react/jsx-runtime' {
  export const Fragment: import('react').ComponentType<{ children?: import('react').ReactNode }>;
  export function jsx(type: string | import('react').ComponentType, props?: Record<string, unknown>, key?: string | number): import('react').ReactElement;
  export function jsxs(type: string | import('react').ComponentType, props?: Record<string, unknown>, key?: string | number): import('react').ReactElement;
}

declare namespace JSX {
  type Element = import('react').ReactElement;
  type ElementType = keyof IntrinsicElements | import('react').ComponentType;
  interface ElementChildrenAttribute { children: {} }
  interface IntrinsicAttributes { key?: string | number }
  interface DOMProps<T = HTMLElement> {
    children?: import('react').ReactNode; key?: string | number; ref?: import('react').MutableRefObject<T | null> | ((node: T | null) => void);
    // React treats a null className as an omitted DOM attribute.
    className?: string | null; style?: import('react').CSSProperties;
    onClick?: (event: import('react').MouseEvent<T>) => void;
    onChange?: (event: import('react').ChangeEvent<T>) => void;
    onKeyDown?: (event: import('react').KeyboardEvent<T>) => void;
    onSubmit?: (event: import('react').FormEvent<T>) => void;
    onFocus?: (event: import('react').SyntheticEvent<T>) => void;
    onToggle?: (event: import('react').SyntheticEvent<T>) => void;
    [attribute: string]: any;
  }
  interface IntrinsicElements {
    div: DOMProps<HTMLDivElement>; span: DOMProps; button: DOMProps<HTMLButtonElement>; input: DOMProps<HTMLInputElement>;
    textarea: DOMProps<HTMLTextAreaElement>; select: DOMProps<HTMLSelectElement>; option: DOMProps<HTMLOptionElement>; label: DOMProps;
    section: DOMProps; header: DOMProps; nav: DOMProps; main: DOMProps; aside: DOMProps; footer: DOMProps; article: DOMProps;
    ul: DOMProps; ol: DOMProps; li: DOMProps; p: DOMProps; h1: DOMProps; h2: DOMProps; h3: DOMProps; h4: DOMProps;
    svg: DOMProps<SVGSVGElement>; path: DOMProps<SVGPathElement>; circle: DOMProps<SVGCircleElement>; rect: DOMProps<SVGRectElement>;
    line: DOMProps<SVGLineElement>; polyline: DOMProps<SVGPolylineElement>; g: DOMProps<SVGGElement>; text: DOMProps<SVGTextElement>;
    defs: DOMProps<SVGDefsElement>; marker: DOMProps<SVGMarkerElement>;
    a: DOMProps<HTMLAnchorElement>; pre: DOMProps; code: DOMProps; table: DOMProps; thead: DOMProps; tbody: DOMProps;
    tr: DOMProps; th: DOMProps; td: DOMProps; br: DOMProps; hr: DOMProps; img: DOMProps<HTMLImageElement>;
    strong: DOMProps; em: DOMProps; small: DOMProps; time: DOMProps; fieldset: DOMProps; legend: DOMProps;
    form: DOMProps<HTMLFormElement>; datalist: DOMProps; figure: DOMProps; figcaption: DOMProps; blockquote: DOMProps;
    dl: DOMProps; dt: DOMProps; dd: DOMProps; details: DOMProps<HTMLDetailsElement>; summary: DOMProps; dialog: DOMProps<HTMLDialogElement>;
  }
}
