/** vite.embed.config.ts が作る、.engawa-embed の中だけに効くようにした styles.css */
declare module 'virtual:engawa-embed-css' {
  const css: string;
  export default css;
}
