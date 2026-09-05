import { parse } from "csv-parse/sync";
import * as fs from "fs";


export const loadCsvFixture = (filename: string): any[][] => {
  const filePath = `${__dirname}/fixtures/${filename}`;
  const content = fs.readFileSync(filePath, "utf8");
  return parse(content, { skip_empty_lines: true });
};
