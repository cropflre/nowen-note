// Deterministic loopback provider for the isolated QA server only, never production.
import http from "node:http";
import { getDb } from "../src/db/schema.ts";
import { setUserAISettings } from "../src/services/user-ai-settings.ts";

export async function installAssetAIQA(userId) {
  const server = http.createServer(async (request,response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      let data;
      if (request.url === "/v1/embeddings") {
        data = {data:body.input.map((text,index) => ({index,embedding:/图|design|reference|Reviewed/i.test(text) ? [1,0] : [0,1]}))};
      } else {
        const input = JSON.parse(body.messages[1].content);
        data = {choices:[{message:{content:JSON.stringify({items:input.files.map(file => ({
          id:file.id,folderId:null,newFolderName:"AI参考资料",tags:["AI建议"],description:"根据文件名推断的参考资料，尚未经用户确认。",reason:"仅依据元数据，未读取文件内容。",
        }))})}}]};
      }
      response.writeHead(200,{"Content-Type":"application/json"}).end(JSON.stringify(data));
    } catch { response.writeHead(500).end(); }
  });
  await new Promise(resolve => server.listen(0,"127.0.0.1",resolve));
  const url = `http://127.0.0.1:${server.address().port}/v1`;
  setUserAISettings(userId,[
    {key:"ai_api_url",value:url},{key:"ai_api_key",value:"isolated-test-key"},
    {key:"ai_model",value:"isolated-file-organizer"},{key:"ai_embedding_model",value:"isolated-metadata-embedding"},
  ]);
  // Existing background content-indexing jobs are outside this metadata-only test.
  getDb().exec("DELETE FROM embedding_queue; DELETE FROM attachment_embedding_queue;");
}
