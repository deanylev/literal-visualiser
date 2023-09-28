// node libraries
import fs from 'fs';
import path from 'path';

// constants
const DATA_DIR = path.resolve(`${__dirname}/data`);

export async function get(key: string, defaultValue = null) {
  try {
    const value = await fs.promises.readFile(`${DATA_DIR}/${key}`, 'utf8');
    return JSON.parse(value);
  } catch {
    return defaultValue;
  }
}

export function set(key: string, value: unknown) {
  return fs.promises.writeFile(`${DATA_DIR}/${key}`, JSON.stringify(value), 'utf8');
}
