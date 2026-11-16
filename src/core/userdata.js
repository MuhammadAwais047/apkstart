'use strict';
/**
 * Build a minimal but **valid** empty ext4 image for the Android Emulator to seed userdata with.
 *
 * Why it is needed (lessons already paid for - do not repeat them):
 * 1. The seed inside the system image package (system-images/.../userdata.img) is really a 1MB all-zero placeholder
 *    file; real formatting is meant to be done by avdmanager calling the SDK's mke2fs. ApkStart writes config.ini directly
 *    and starts the emulator, skipping that step - so /data stayed all-zero,
 *    the kernel reported "Invalid ext4 superblock on /dev/block/vdc", the guest fell into a
 *    recovery reboot loop and adbd never came up. The symptom was "tap an app, wait minutes, then failure".
 *    (The emulator ships e2fsck/resize2fs/tune2fs but **no mke2fs**, so it will not format either.)
 *
 * 2. The block size must be 4096. Android 13's /data uses metadata encryption,
 *    and vold stacks a dm-default-key layer over userdata. That dm device has a logical block size of
 *    4096, while the kernel's sb_set_blocksize() requires fs block size >= logical block size,
 *    so a 1KB-block image yields mount() = EINVAL with a log like this:
 *      vold: [libfs_mgr] Cannot mount filesystem on /dev/block/dm-40 at /data: Invalid argument
 *      vold: fs_mgr_do_mount failed with rc -1
 *    A 4KB block works.
 *
 * 3. EXT4_FEATURE_INCOMPAT_ENCRYPT(0x10000) must be set, or vold's
 *    `cryptfs init_user0` fails outright (exit 25) -> another recovery reboot.
 *
 * The image is only 64MB; the emulator resizes it to the AVD's configured dataPartition size at boot,
 * and e2fsck/resize2fs inside the guest grow the filesystem to fill it, so it does not need to be large here.
 */

const BLOCK = 4096;
const INODE_SIZE = 128;
const FIRST_INO = 11;

// ext4 feature bits
const COMPAT_EXT_ATTR = 0x8;    // without it setxattr returns EOPNOTSUPP: SELinux labels cannot be written,
                                // and netd / media / tombstoned all exit with status 1
const COMPAT_DIR_INDEX = 0x20;
const INCOMPAT_FILETYPE = 0x2;
const INCOMPAT_ENCRYPT = 0x10000;
const RO_COMPAT_SPARSE_SUPER = 0x1;
const RO_COMPAT_LARGE_FILE = 0x2;

/**
 * @param {{sizeMB?: number, encrypt?: boolean}} [opts]
 *   With encrypt=false the ENCRYPT bit is omitted - used only so "the emulator's own
 *   e2fsck/resize2fs (1.42.12, which does not understand encrypt) can first grow the filesystem to the partition size",
 *   after which the bit is added back.
 * @returns {Buffer} bytes that can be written straight out as a userdata image
 */
function buildEmptyExt4(opts = {}) {
  const sizeMB = Math.max(8, Math.min(96, Math.round(opts.sizeMB || 64)));
  const blocks = Math.floor((sizeMB * 1024 * 1024) / BLOCK);
  // Single block group: with 4KB blocks one group holds at most 8*4096 = 32768 blocks (128MB)
  const blocksPerGroup = Math.min(blocks, 8 * BLOCK);

  let inodes = Math.max(256, Math.round(blocks / 4));
  inodes = Math.ceil(inodes / 8) * 8;
  const inodeTableBlocks = Math.ceil((inodes * INODE_SIZE) / BLOCK);

  const GD_BLOCK = 1;
  const BB_BLOCK = 2;
  const IB_BLOCK = 3;
  const ITABLE_BLOCK = 4;
  const DIR_BLOCK = ITABLE_BLOCK + inodeTableBlocks;
  const usedBlocks = DIR_BLOCK + 1; // occupied blocks (0..DIR_BLOCK)

  const buf = Buffer.alloc(blocks * BLOCK, 0);
  const now = Math.floor(Date.now() / 1000);
  const sb = 1024; // the superblock is fixed at offset 1024

  // ---------- superblock ----------
  const reserved = Math.floor(blocks * 0.05);
  buf.writeUInt32LE(inodes, sb + 0x00);                       // s_inodes_count
  buf.writeUInt32LE(blocks, sb + 0x04);                       // s_blocks_count_lo
  buf.writeUInt32LE(reserved, sb + 0x08);                     // s_r_blocks_count
  buf.writeUInt32LE(blocks - usedBlocks, sb + 0x0C);          // s_free_blocks_count
  buf.writeUInt32LE(inodes - (FIRST_INO - 1), sb + 0x10);     // s_free_inodes_count (must exclude reserved inodes 1-10)
  buf.writeUInt32LE(0, sb + 0x14);                            // s_first_data_block (0 for 4K blocks)
  buf.writeUInt32LE(2, sb + 0x18);                            // s_log_block_size = 2 → 4096
  buf.writeUInt32LE(2, sb + 0x1C);                            // s_log_cluster_size (must equal the block size, or EINVAL)
  buf.writeUInt32LE(blocksPerGroup, sb + 0x20);               // s_blocks_per_group
  buf.writeUInt32LE(blocksPerGroup, sb + 0x24);               // s_clusters_per_group
  buf.writeUInt32LE(inodes, sb + 0x28);                       // s_inodes_per_group
  buf.writeUInt32LE(now, sb + 0x2C);                          // s_mtime
  buf.writeUInt32LE(now, sb + 0x30);                          // s_wtime
  buf.writeUInt16LE(0, sb + 0x34);                            // s_mnt_count
  buf.writeUInt16LE(0xFFFF, sb + 0x36);                       // s_max_mnt_count
  buf.writeUInt16LE(0xEF53, sb + 0x38);                       // magic
  buf.writeUInt16LE(1, sb + 0x3A);                            // s_state = clean
  buf.writeUInt16LE(1, sb + 0x3C);                            // s_errors = continue (never leave it 0)
  buf.writeUInt16LE(0, sb + 0x3E);                            // s_minor_rev_level
  buf.writeUInt32LE(now, sb + 0x40);                          // s_lastcheck
  buf.writeUInt32LE(0, sb + 0x44);                            // s_checkinterval
  buf.writeUInt32LE(0, sb + 0x48);                            // s_creator_os = Linux
  buf.writeUInt32LE(1, sb + 0x4C);                            // s_rev_level = dynamic
  buf.writeUInt16LE(0, sb + 0x50);                            // s_def_resuid
  buf.writeUInt16LE(0, sb + 0x52);                            // s_def_resgid
  buf.writeUInt32LE(FIRST_INO, sb + 0x54);                    // s_first_ino
  buf.writeUInt16LE(INODE_SIZE, sb + 0x58);                   // s_inode_size
  buf.writeUInt16LE(0, sb + 0x5A);                            // s_block_group_nr
  buf.writeUInt32LE(COMPAT_EXT_ATTR | COMPAT_DIR_INDEX, sb + 0x5C); // s_feature_compat
  buf.writeUInt32LE(INCOMPAT_FILETYPE | (opts.encrypt === false ? 0 : INCOMPAT_ENCRYPT), sb + 0x60); // s_feature_incompat
  buf.writeUInt32LE(RO_COMPAT_SPARSE_SUPER | RO_COMPAT_LARGE_FILE, sb + 0x64);
  Buffer.from('61706b7374617274303031', 'hex').copy(buf, sb + 0x68); // s_uuid
  buf.write('data', sb + 0x78, 'ascii');                      // s_volume_name
  buf.write('/data', sb + 0x88, 'ascii');                      // s_last_mounted
  buf.writeUInt32LE(0, sb + 0xC8);                             // s_algorithm_usage_bitmap
  buf.writeUInt8(0, sb + 0xCC + 1);                            // s_prealloc_blocks
  buf.writeUInt8(0, sb + 0xCE);
  // Supported encryption algorithms: 1 = AES-256-XTS, 2 = AES-256-CTS (the Android default pair)
  buf.writeUInt32LE(1, sb + 0x274);
  buf.writeUInt32LE(2, sb + 0x278);
  buf.writeUInt8(2, sb + 0xFC);                                // s_def_hash_version = half_md4
  buf.writeUInt16LE(0, sb + 0xFE);                             // s_desc_size (0 for non-64bit)

  // ---------- group descriptor（block 1）----------
  const gd = GD_BLOCK * BLOCK;
  buf.writeUInt32LE(BB_BLOCK, gd + 0x00);                      // bg_block_bitmap
  buf.writeUInt32LE(IB_BLOCK, gd + 0x04);                      // bg_inode_bitmap
  buf.writeUInt32LE(ITABLE_BLOCK, gd + 0x08);                  // bg_inode_table
  buf.writeUInt16LE(blocksPerGroup - usedBlocks, gd + 0x0C);   // bg_free_blocks_count
  buf.writeUInt16LE(inodes - FIRST_INO + 1, gd + 0x0E);        // bg_free_inodes_count
  buf.writeUInt16LE(1, gd + 0x10);                             // bg_used_dirs_count
  buf.writeUInt16LE(0, gd + 0x12);                             // bg_flags

  // ---------- block bitmap（block 2）：bit i ↔ block i ----------
  const bb = BB_BLOCK * BLOCK;
  for (let blk = 0; blk < usedBlocks; blk += 1) {
    buf[bb + (blk >> 3)] |= 1 << (blk & 7);
  }
  // Padding bits beyond the real block count must be set (the bitmap covers all blocks_per_group)
  for (let bit = blocks; bit < blocksPerGroup; bit += 1) {
    buf[bb + (bit >> 3)] |= 1 << (bit & 7);
  }

  // ---------- inode bitmap (block 3): 1..10 reserved for the system ----------
  const ib = IB_BLOCK * BLOCK;
  for (let i = 0; i < FIRST_INO - 1; i += 1) {
    buf[ib + (i >> 3)] |= 1 << (i & 7);
  }

  // ---------- root inode（inode 2）----------
  const rootOff = ITABLE_BLOCK * BLOCK + (2 - 1) * INODE_SIZE;
  buf.writeUInt16LE(0x41ED, rootOff + 0x00);        // S_IFDIR | 0755
  buf.writeUInt16LE(0, rootOff + 0x02);             // i_uid
  buf.writeUInt32LE(BLOCK, rootOff + 0x04);         // i_size
  buf.writeUInt32LE(now, rootOff + 0x08);           // i_atime
  buf.writeUInt32LE(now, rootOff + 0x0C);           // i_ctime
  buf.writeUInt32LE(now, rootOff + 0x10);           // i_mtime
  buf.writeUInt32LE(0, rootOff + 0x14);             // i_dtime
  buf.writeUInt16LE(0, rootOff + 0x18);             // i_gid
  buf.writeUInt16LE(2, rootOff + 0x1A);             // i_links_count
  buf.writeUInt32LE(BLOCK / 512, rootOff + 0x1C);   // i_blocks (in 512B units)
  buf.writeUInt32LE(0, rootOff + 0x20);             // i_flags
  buf.writeUInt32LE(DIR_BLOCK, rootOff + 0x28);     // i_block[0] (no extents, direct block)

  // ---------- root directory data block ----------
  const dir = DIR_BLOCK * BLOCK;
  buf.writeUInt32LE(2, dir + 0);                    // "." → inode 2
  buf.writeUInt16LE(12, dir + 4);
  buf.writeUInt8(1, dir + 6);                       // name_len
  buf.writeUInt8(2, dir + 7);                       // file_type = DIR
  buf.write('.', dir + 8, 'ascii');

  buf.writeUInt32LE(2, dir + 12);                   // ".." → inode 2
  buf.writeUInt16LE(BLOCK - 12, dir + 16);
  buf.writeUInt8(2, dir + 18);
  buf.writeUInt8(2, dir + 19);
  buf.write('..', dir + 20, 'ascii');

  return buf;
}

/** Check whether an image carries the ext4 magic (used for self-healing: rebuild when all-zero or corrupt) */
function hasExt4Superblock(file) {
  let fd;
  try {
    fd = require('fs').openSync(file, 'r');
    const head = Buffer.alloc(2048);
    const n = require('fs').readSync(fd, head, 0, 2048, 0);
    if (n < 2048) return false;
    return head.readUInt16LE(1024 + 0x38) === 0xEF53;
  } catch (_) {
    return false;
  } finally {
    if (fd !== undefined) {
      try { require('fs').closeSync(fd); } catch (_) { /* ignore */ }
    }
  }
}

/**
 * Put the ENCRYPT (fscrypt) feature bit back into the superblock.
 * Order matters: the emulator's own resize2fs must first grow the filesystem to the partition size,
 * and only then is the bit added - that cygwin e2fsprogs is 1.42.12 and does not understand encrypt,
 * so e2fsck/resize2fs refuse to run with the bit set.
 */
function setEncryptFlag(file) {
  const fs = require('fs');
  const fd = fs.openSync(file, 'r+');
  try {
    const b = Buffer.alloc(4);
    const at = 1024 + 0x60; // s_feature_incompat
    fs.readSync(fd, b, 0, 4, at);
    b.writeUInt32LE(b.readUInt32LE(0) | INCOMPAT_ENCRYPT, 0);
    fs.writeSync(fd, b, 0, 4, at);
  } finally {
    fs.closeSync(fd);
  }
}

/** The ENCRYPT bit must be cleared before resize2fs (old e2fsprogs rejects it) */
function clearEncryptFlag(file) {
  const fs = require('fs');
  const fd = fs.openSync(file, 'r+');
  try {
    const b = Buffer.alloc(4);
    const at = 1024 + 0x60;
    fs.readSync(fd, b, 0, 4, at);
    b.writeUInt32LE(b.readUInt32LE(0) & ~INCOMPAT_ENCRYPT, 0);
    fs.writeSync(fd, b, 0, 4, at);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Read the filesystem's **own** capacity (bytes).
 * Key use: a qemu-img-grown 8GB image file does not mean the ext4 inside grew to 8GB too.
 * If resize2fs failed (as happens with the wrong qemu-img argument order in old versions),
 * the file looks 6GB while Android has only 64MB free - exactly the "not enough space installing games/updates" symptom.
 * So the superblock's block count and block size are read directly to decide whether resize2fs must run again.
 */
function fsBytes(file) {
  let fd;
  try {
    fd = require('fs').openSync(file, 'r');
    const sb = Buffer.alloc(2048);
    const n = require('fs').readSync(fd, sb, 0, sb.length, 0);
    if (n < 2048) return 0;
    if (sb.readUInt16LE(1024 + 0x38) !== 0xEF53) return 0;
    const blocksLo = sb.readUInt32LE(1024 + 0x4);
    const logBlock = sb.readUInt32LE(1024 + 0x18) & 0xffff;
    const blockSize = 1024 << logBlock;
    return blocksLo * blockSize;
  } catch (_) {
    return 0;
  } finally {
    if (fd !== undefined) {
      try { require('fs').closeSync(fd); } catch (_) { /* ignore */ }
    }
  }
}

module.exports = {
  buildEmptyExt4, hasExt4Superblock, setEncryptFlag, clearEncryptFlag, fsBytes, BLOCK,
};
