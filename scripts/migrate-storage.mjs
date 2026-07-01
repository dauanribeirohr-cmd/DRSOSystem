import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { copyFile, mkdir, readdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  projectRoot as configuredProjectRoot,
  dataRootDir,
  dataDir,
  uploadsDir,
  galleryDir,
  backupsDir,
  logsDir,
  requiredStorageDirs,
  isPathInside
} from "../server/storage-paths.mjs";

const dryRun = process.argv.includes("--dry-run");
const force = process.argv.includes("--force");
const sourceProjectRoot = path.resolve(String(process.env.DRSO_MIGRATION_PROJECT_DIR || configuredProjectRoot));
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const migrationBackupDir = path.join(backupsDir, `migration-${stamp}`);
const migrationMarker = path.join(dataDir, ".storage-migration-v1.complete");

if (isPathInside(sourceProjectRoot, dataRootDir) || isPathInside(dataRootDir, sourceProjectRoot)) {
  throw new Error(`Origem e destino da migracao nao podem estar contidos um no outro. Origem: ${sourceProjectRoot}. Destino: ${dataRootDir}.`);
}

if (!dryRun && !force && existsSync(migrationMarker)) {
  console.log(`[Migracao] Migracao ja concluida anteriormente: ${migrationMarker}`);
  process.exit(0);
}

async function listFiles(root) {
  if (!existsSync(root)) return [];
  const rootStat = await stat(root);
  if (rootStat.isFile()) return [{ fullPath: root, relativePath: path.basename(root), info: rootStat }];
  const files = [];

  async function walk(current) {
    for (const item of await readdir(current, { withFileTypes: true })) {
      const fullPath = path.join(current, item.name);
      if (item.isDirectory()) await walk(fullPath);
      else if (item.isFile()) files.push({ fullPath, relativePath: path.relative(root, fullPath), info: await stat(fullPath) });
    }
  }

  await walk(root);
  return files;
}

function projectDataDestination(relativePath) {
  const parts = relativePath.split(/[\\/]+/);
  const first = parts[0]?.toLowerCase();
  if (first === "documents") return path.join(uploadsDir, "documents", ...parts.slice(1));
  if (first === "music") return path.join(uploadsDir, "music", ...parts.slice(1));
  if (["galeria", "gallery"].includes(first)) return path.join(galleryDir, ...parts.slice(1));
  return path.join(dataDir, ...parts);
}

const oldSiblingStorage = path.join(path.dirname(sourceProjectRoot), "DRSOStorage");
const sourceDefinitions = [
  { label: "project-data", source: path.join(sourceProjectRoot, "data"), destination: projectDataDestination },
  { label: "project-uploads", source: path.join(sourceProjectRoot, "uploads"), destination: (relative) => path.join(uploadsDir, relative) },
  { label: "project-storage", source: path.join(sourceProjectRoot, "storage"), destination: (relative) => path.join(uploadsDir, "legacy-storage", relative) },
  { label: "project-backups", source: path.join(sourceProjectRoot, "backups"), destination: (relative) => path.join(backupsDir, "legacy", relative) },
  { label: "project-logs", source: path.join(sourceProjectRoot, "logs"), destination: (relative) => path.join(logsDir, relative) },
  { label: "project-env", source: path.join(sourceProjectRoot, ".env"), destination: () => path.join(dataDir, ".env") },
  { label: "legacy-gallery", source: path.join(oldSiblingStorage, "Galeria"), destination: (relative) => path.join(galleryDir, relative) },
  { label: "legacy-gallery-en", source: path.join(oldSiblingStorage, "gallery"), destination: (relative) => path.join(galleryDir, relative) },
  { label: "legacy-data", source: path.join(oldSiblingStorage, "data"), destination: (relative) => path.join(dataDir, relative) },
  { label: "legacy-uploads", source: path.join(oldSiblingStorage, "uploads"), destination: (relative) => path.join(uploadsDir, relative) },
  { label: "legacy-backups", source: path.join(oldSiblingStorage, "backups"), destination: (relative) => path.join(backupsDir, "legacy", relative) },
  { label: "legacy-logs", source: path.join(oldSiblingStorage, "logs"), destination: (relative) => path.join(logsDir, relative) }
];

const entries = [];
const seenSources = new Set();
for (const definition of sourceDefinitions) {
  const resolvedSource = path.resolve(definition.source);
  if (isPathInside(dataRootDir, resolvedSource) || seenSources.has(resolvedSource.toLowerCase())) continue;
  seenSources.add(resolvedSource.toLowerCase());
  for (const file of await listFiles(resolvedSource)) {
    entries.push({
      ...file,
      label: definition.label,
      destination: path.resolve(definition.destination(file.relativePath))
    });
  }
}

for (const entry of entries) {
  if (!isPathInside(dataRootDir, entry.destination)) {
    throw new Error(`Destino de migracao fora de DRSO_DATA_DIR: ${entry.destination}`);
  }
}

console.log(`[Migracao] Origem do projeto: ${sourceProjectRoot}`);
console.log(`[Migracao] Destino permanente: ${dataRootDir}`);
console.log(`[Migracao] Arquivos encontrados: ${entries.length}`);

if (dryRun) {
  console.log("[Migracao] Simulacao concluida. Nenhum arquivo foi alterado.");
  process.exit(0);
}

await Promise.all(requiredStorageDirs.map((directory) => mkdir(directory, { recursive: true })));

if (!entries.length) {
  await writeFile(migrationMarker, `${new Date().toISOString()}\n`, { flag: force ? "w" : "wx" });
  console.log("[Migracao] Nenhum dado legado encontrado. Estrutura permanente pronta.");
  process.exit(0);
}

async function sha256(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

async function copyPreservingTime(source, destination, exclusive = false) {
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(source, destination, exclusive ? fsConstants.COPYFILE_EXCL : 0);
  const info = await stat(source);
  await utimes(destination, info.atime, info.mtime);
}

// O backup termina por completo antes que qualquer arquivo seja copiado ao
// destino operacional. Os arquivos de origem nunca sao apagados pelo script.
for (const entry of entries) {
  const backupPath = path.join(migrationBackupDir, entry.label, entry.relativePath);
  await copyPreservingTime(entry.fullPath, backupPath, true);
}
console.log(`[Migracao] Backup previo concluido: ${migrationBackupDir}`);

for (const entry of entries) {
  if (!existsSync(entry.destination) || path.basename(entry.destination).toLowerCase() !== "drsosystem.sqlite") continue;
  if (await sha256(entry.fullPath) !== await sha256(entry.destination)) {
    throw new Error(`Conflito entre bancos SQLite. Nada foi sobrescrito. Origem: ${entry.fullPath}. Destino: ${entry.destination}. Backup: ${migrationBackupDir}.`);
  }
}

let copied = 0;
let identical = 0;
let conflicts = 0;
for (const entry of entries) {
  let destination = entry.destination;
  if (existsSync(destination)) {
    if (await sha256(entry.fullPath) === await sha256(destination)) {
      identical += 1;
      continue;
    }
    destination = `${destination}.migrated-${stamp}`;
    conflicts += 1;
  }
  await copyPreservingTime(entry.fullPath, destination, true);
  copied += 1;
}

await writeFile(migrationMarker, `${new Date().toISOString()}\nBackup: ${migrationBackupDir}\n`, { flag: force ? "w" : "wx" });
console.log(`[Migracao] Concluida: ${copied} copiados, ${identical} ja identicos, ${conflicts} conflitos preservados com novo nome.`);
console.log("[Migracao] Os arquivos originais foram mantidos. Remova-os manualmente somente depois de validar o sistema.");
