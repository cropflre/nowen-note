declare module "word-extractor" {
  class WordExtractor {
    extract(filePath: string): Promise<{ getBody(): string }>;
  }
  export = WordExtractor;
}
