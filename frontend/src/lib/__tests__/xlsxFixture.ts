import JSZip from "jszip";

export async function workbookFixture(sheets: Array<{ name: string; xml: string }>, extras: Record<string, string> = {}) {
  const zip = new JSZip();
  zip.file("xl/workbook.xml", `<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((sheet, index) => `<sheet name="${sheet.name}" r:id="r${index}"/>`).join("")}</sheets></workbook>`);
  zip.file("xl/_rels/workbook.xml.rels", `<Relationships>${sheets.map((_, index) => `<Relationship Id="r${index}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="/xl/worksheets/custom${index}.xml"/>`).join("")}</Relationships>`);
  sheets.forEach((sheet, index) => zip.file(`xl/worksheets/custom${index}.xml`, sheet.xml));
  Object.entries(extras).forEach(([path, xml]) => zip.file(path, xml));
  return zip.generateAsync({ type: "arraybuffer", compression: "DEFLATE" });
}

export const dataWorksheet = '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>名称</t></is></c><c r="B1" t="inlineStr"><is><t>金额</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>房租</t></is></c><c r="B2"><v>3000</v></c></row></sheetData></worksheet>';
