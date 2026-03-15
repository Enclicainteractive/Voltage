/**
 * JSON Compatibility Service - DEPRECATED
 * 
 * This service previously monkey-patched fs.readFileSync/writeFileSync/existsSync
 * to intercept reads/writes to managed .json data files and redirect them to DB.
 * 
 * Now that the DB is the single source of truth and JSON file storage is fully
 * deprecated, this module is a no-op. It remains only for import compatibility.
 */

export const installJsonCompat = () => {
  // No-op: JSON file compatibility layer is no longer needed.
  // All data is read/written through the database via dataService.
}

export default {
  installJsonCompat
}
