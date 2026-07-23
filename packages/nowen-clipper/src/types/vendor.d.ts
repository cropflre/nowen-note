declare module "@mixmark-io/domino" {
  const domino: {
    createDocument(markup?: string): Document;
  };
  export default domino;
}

declare module "turndown-plugin-gfm" {
  export const gfm: any;
  export const strikethrough: any;
  export const tables: any;
  export const taskListItems: any;
}
