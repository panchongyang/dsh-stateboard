// The client build imports CSS as text; declarations add no runtime dependency.
declare module '*.css' {
  const css: string;
  export default css;
}
