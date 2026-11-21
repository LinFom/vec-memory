import { previewPortableMerge, commitPortableMerge, restorePortableRecords } from '../interop/merge-portable-memory.mjs';
import { restoreLegacyMemory } from '../interop/restore-legacy-memory.mjs';
import { exportMemoryMessages, previewMemoryData, restoreMemoryMessages } from '../interop/preview-memory-data.mjs';

try {
  const args=process.argv.slice(2),includeRoleNotes=args.includes('--include-role-notes');
  const [action, source, destination, namespace, token] = args.filter(value=>value!=='--include-role-notes');
  let result;
  if (action === 'preview' && source && !destination) {
    result = await previewMemoryData(source, { password: process.env.VEC_MEMORY_BACKUP_PASSWORD });
  } else if (action === 'restore-legacy' && source && destination) {
    result = await restoreLegacyMemory(source, destination, {
      password: process.env.VEC_MEMORY_BACKUP_PASSWORD,
      expectedChecksum: namespace,
    });
  } else if (action === 'restore-messages' && source && destination && !namespace) {
    result = await restoreMemoryMessages(source, destination);
  } else if (action === 'restore-records' && source && destination && !namespace) {
    result = await restorePortableRecords(source,destination);
  } else if (action === 'merge-preview' && source && destination && namespace && !token) {
    result = await previewPortableMerge(source, destination, namespace);
  } else if (action === 'merge-commit' && source && destination && namespace && token) {
    result = await commitPortableMerge(source, destination, namespace, token);
  } else if (['export-messages', 'export-records'].includes(action) && source && destination && namespace) {
    result = await exportMemoryMessages(source, destination, namespace, { includeObservations: action === 'export-records', includeRoleNotes });
  } else {
    throw Error('Usage: node tools/portable-memory-data.mjs preview <source> | export-messages|export-records <space-directory> <new-directory> <stable-namespace> | restore-messages <bundle-directory> <new-space-directory> | restore-legacy <archive.vmb> <new-directory> [expected-checksum] | merge-preview <service-root> <space-id> <bundle> | merge-commit <service-root> <space-id> <bundle> <token>');
  }
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
