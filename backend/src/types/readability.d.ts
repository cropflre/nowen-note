declare module "@mozilla/readability/JSDOMParser.js" {
  export default class JSDOMParser {
    parse(html: string, url?: string): Document;
  }
}
