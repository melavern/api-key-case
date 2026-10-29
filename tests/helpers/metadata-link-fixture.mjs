import { mkdirSync, symlinkSync } from 'node:fs';

// Windows file symlinks require a privilege this acceptance machine does not
// have. An owned directory junction at the metadata filename still exercises
// rejection of linked/non-file selectors without changing machine settings.
// POSIX retains the file-symlink case; this is not Windows file-symlink proof.
export function unsafeMetadataLink(backing, destination) {
  if (process.platform === 'win32') {
    const directory = backing + '.directory';
    mkdirSync(directory);
    symlinkSync(directory, destination, 'junction');
    return directory;
  }
  symlinkSync(backing, destination);
  return backing;
}
