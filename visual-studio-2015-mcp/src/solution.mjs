import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

export async function inspectSolution(filename) {
  const fullPath = path.resolve(filename);
  if (path.extname(fullPath).toLowerCase() !== '.sln') throw new Error('Expected a classic .sln file.');
  if ((await stat(fullPath)).size > 8 * 1024 * 1024) throw new Error('Solution exceeds the 8 MiB inspection limit.');
  const bytes = await readFile(fullPath);
  const content = bytes[0] === 0xff && bytes[1] === 0xfe ? bytes.subarray(2).toString('utf16le') : bytes.toString('utf8');
  if (!content.includes('Microsoft Visual Studio Solution File')) throw new Error('Not a Visual Studio solution.');
  const projects = [...content.matchAll(/^Project\("(\{[^}]+\})"\)\s*=\s*"([^"]*)",\s*"([^"]*)",\s*"(\{[^}]+\})"/gm)]
    .map(([, typeGuid, name, relativePath, guid]) => ({ typeGuid, name, relativePath, guid }));
  const section = content.match(/GlobalSection\(SolutionConfigurationPlatforms\)[^\r\n]*\r?\n([\s\S]*?)EndGlobalSection/);
  const configurations = section ? section[1].split(/\r?\n/).map(line => line.split('=')[0].trim()).filter(Boolean) : [];
  return { path: fullPath, projects, configurations, evaluated: false,
    note: 'Static solution metadata only. Conditional project properties and imports are not evaluated.' };
}
