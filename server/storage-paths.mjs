import path from "node:path";
import { fileURLToPath } from "node:url";

const serverDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(serverDir, "..");
const defaultDataRoot = "C:\\DRSOStorage";
const dataRootDir = path.resolve(String(process.env.DRSO_DATA_DIR || defaultDataRoot).trim());

function isPathInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

if (isPathInside(projectRoot, dataRootDir)) {
  throw new Error(`DRSO_DATA_DIR deve ficar fora da pasta do projeto. Projeto: ${projectRoot}. Dados: ${dataRootDir}.`);
}

const dataDir = path.join(dataRootDir, "data");
const uploadsDir = path.join(dataRootDir, "uploads");
const galleryDir = path.join(dataRootDir, "gallery");
const backupsDir = path.join(dataRootDir, "backups");
const logsDir = path.join(dataRootDir, "logs");
const documentUploadsDir = path.join(uploadsDir, "documents");
const musicUploadsDir = path.join(uploadsDir, "music");
const dbPath = path.join(dataDir, "drsosystem.sqlite");
const persistentEnvPath = path.join(dataDir, ".env");
const legacyDbCandidates = [
  path.join(projectRoot, "data", "drsosystem.sqlite"),
  path.join(path.dirname(projectRoot), "DRSOStorage", "data", "drsosystem.sqlite")
].filter((candidate) => path.resolve(candidate) !== dbPath);

const requiredStorageDirs = [
  dataRootDir,
  dataDir,
  uploadsDir,
  galleryDir,
  backupsDir,
  logsDir,
  documentUploadsDir,
  musicUploadsDir
];

export {
  projectRoot,
  defaultDataRoot,
  dataRootDir,
  dataDir,
  uploadsDir,
  galleryDir,
  backupsDir,
  logsDir,
  documentUploadsDir,
  musicUploadsDir,
  dbPath,
  persistentEnvPath,
  legacyDbCandidates,
  requiredStorageDirs,
  isPathInside
};
