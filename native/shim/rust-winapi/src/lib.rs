//! winapi 0.3 の代わり (Cargo.toml を参照)。DLL (SAORI) は native/shim/engawa_saori.c に渡す。
#![allow(non_snake_case, non_camel_case_types, clippy::missing_safety_doc)]

use core::ffi::c_void;

extern "C" {
    fn malloc(size: usize) -> *mut c_void;
    fn calloc(n: usize, size: usize) -> *mut c_void;
    fn free(ptr: *mut c_void);
    fn malloc_usable_size(ptr: *mut c_void) -> usize;
    fn engawa_dlopen(path: *const i8, flags: i32) -> *mut c_void;
    fn engawa_dlsym(handle: *mut c_void, name: *const i8) -> *mut c_void;
    fn engawa_dlclose(handle: *mut c_void) -> i32;
    fn engawa_cp932_to_unicode(input: *const u8, left: usize, cp: *mut u32) -> i32;
    fn engawa_unicode_to_cp932(cp: u32, out: *mut u8) -> i32;
}

pub mod ctypes {
    pub type c_int = i32;
    pub type c_long = i32;
    pub type c_void = core::ffi::c_void;
}

pub mod shared {
    pub mod minwindef {
        pub type HGLOBAL = *mut core::ffi::c_void;
        pub type HMODULE = *mut core::ffi::c_void;
        pub type HINSTANCE = HMODULE;
        pub type FARPROC = *mut core::ffi::c_void;
        pub type BOOL = i32;
        pub type DWORD = u32;
        pub type UINT = u32;
        pub type LPDWORD = *mut DWORD;
        pub type LPVOID = *mut core::ffi::c_void;
        pub type LPBOOL = *mut BOOL;
        pub const TRUE: BOOL = 1;
        pub const FALSE: BOOL = 0;
        pub const MAX_PATH: usize = 260;
    }

    pub mod ntdef {
        pub type LPCSTR = *const i8;
        pub type LPSTR = *mut i8;
        pub type LPWSTR = *mut u16;
        pub const NULL: *mut core::ffi::c_void = core::ptr::null_mut();
    }
}

pub mod um {
    pub mod winnt {
        use crate::shared::minwindef::DWORD;
        pub type HANDLE = *mut core::ffi::c_void;
        pub type LPCWSTR = *const u16;
        pub type LPCSTR = *const i8;
        pub type LPSTR = *mut i8;
        pub const DLL_PROCESS_DETACH: DWORD = 0;
        pub const DLL_PROCESS_ATTACH: DWORD = 1;
        pub const DLL_THREAD_ATTACH: DWORD = 2;
        pub const DLL_THREAD_DETACH: DWORD = 3;
    }

    pub mod winnls {
        use crate::shared::minwindef::DWORD;
        pub const MB_PRECOMPOSED: DWORD = 1;
    }

    /// 文字コードの変換。CP932 (932) は native/shim/engawa_iconv.c の表で、ほか (UTF-8 など) は UTF-8 として扱う。
    /// srclen が -1 なら NUL まで (NUL も数える)。dst が NULL か dstlen が 0 なら、要る大きさを返す
    pub mod stringapiset {
        use crate::shared::minwindef::{BOOL, DWORD, UINT};

        unsafe fn source<T: Copy + PartialEq + Default>(src: *const T, srclen: i32) -> Vec<T> {
            let len = if srclen >= 0 {
                srclen as usize
            } else {
                let mut n = 0;
                while *src.add(n) != T::default() {
                    n += 1;
                }
                n + 1
            };
            core::slice::from_raw_parts(src, len).to_vec()
        }

        unsafe fn output<T: Copy>(out: &[T], dst: *mut T, dstlen: i32) -> i32 {
            if dst.is_null() || dstlen == 0 {
                return out.len() as i32;
            }
            if out.len() > dstlen as usize {
                return 0;
            }
            core::ptr::copy_nonoverlapping(out.as_ptr(), dst, out.len());
            out.len() as i32
        }

        pub unsafe fn MultiByteToWideChar(codepage: UINT, _flags: DWORD, src: *const i8, srclen: i32, dst: *mut u16, dstlen: i32) -> i32 {
            let bytes: Vec<u8> = source(src, srclen).into_iter().map(|b| b as u8).collect();
            let text: String = if codepage == 932 || codepage == 0 || codepage == 1 {
                let mut s = String::new();
                let mut i = 0;
                while i < bytes.len() {
                    if bytes[i] < 0x80 {
                        s.push(bytes[i] as char);
                        i += 1;
                        continue;
                    }
                    let mut cp = 0u32;
                    let n = crate::engawa_cp932_to_unicode(bytes.as_ptr().add(i), bytes.len() - i, &mut cp);
                    if n <= 0 {
                        s.push('\u{fffd}');
                        i += 1;
                    } else {
                        s.push(char::from_u32(cp).unwrap_or('\u{fffd}'));
                        i += n as usize;
                    }
                }
                s
            } else {
                String::from_utf8_lossy(&bytes).into_owned()
            };
            output(&text.encode_utf16().collect::<Vec<u16>>(), dst, dstlen)
        }

        pub unsafe fn WideCharToMultiByte(
            codepage: UINT,
            _flags: DWORD,
            src: *const u16,
            srclen: i32,
            dst: *mut i8,
            dstlen: i32,
            _default: *const i8,
            _used: *mut BOOL,
        ) -> i32 {
            let wide = source(src, srclen);
            let mut out: Vec<i8> = Vec::new();
            for c in char::decode_utf16(wide.into_iter()).map(|r| r.unwrap_or('\u{fffd}')) {
                if (c as u32) < 0x80 {
                    out.push(c as u32 as i8);
                } else if codepage == 932 || codepage == 0 || codepage == 1 {
                    let mut buf = [0u8; 2];
                    let n = crate::engawa_unicode_to_cp932(c as u32, buf.as_mut_ptr());
                    if n <= 0 {
                        out.push(b'?' as i8);
                    } else {
                        out.extend(buf[..n as usize].iter().map(|b| *b as i8));
                    }
                } else {
                    let mut buf = [0u8; 4];
                    out.extend(c.encode_utf8(&mut buf).bytes().map(|b| b as i8));
                }
            }
            output(&out, dst, dstlen)
        }
    }

    pub mod winbase {
        use crate::shared::minwindef::{DWORD, HGLOBAL, UINT};
        pub const GMEM_FIXED: UINT = 0;
        pub const GMEM_ZEROINIT: UINT = 0x40;
        pub const STD_ERROR_HANDLE: DWORD = 0xFFFF_FFF4;

        pub unsafe fn GlobalAlloc(flags: UINT, size: usize) -> HGLOBAL {
            let n = if size == 0 { 1 } else { size };
            if flags & GMEM_ZEROINIT != 0 { crate::calloc(1, n) } else { crate::malloc(n) }
        }
        pub unsafe fn GlobalFree(mem: HGLOBAL) -> HGLOBAL {
            crate::free(mem);
            core::ptr::null_mut()
        }
        pub unsafe fn GlobalSize(mem: HGLOBAL) -> usize {
            if mem.is_null() { 0 } else { crate::malloc_usable_size(mem) }
        }
    }

    pub mod libloaderapi {
        use crate::shared::minwindef::{BOOL, DWORD, FARPROC, HMODULE};
        /// DLL のパスは分からない (SAORI のパスは load で受け取る)。0 を返す
        pub unsafe fn GetModuleFileNameW(_module: HMODULE, buf: *mut u16, size: DWORD) -> DWORD {
            if size > 0 && !buf.is_null() {
                *buf = 0;
            }
            0
        }
        /// UTF-16 のパスを UTF-8 にし、\ を / にして engawa_dlopen に渡す
        pub unsafe fn LoadLibraryW(name: *const u16) -> HMODULE {
            if name.is_null() {
                return core::ptr::null_mut();
            }
            let mut len = 0;
            while *name.add(len) != 0 {
                len += 1;
            }
            let path = String::from_utf16_lossy(core::slice::from_raw_parts(name, len)).replace('\\', "/");
            let mut bytes = path.into_bytes();
            bytes.push(0);
            crate::engawa_dlopen(bytes.as_ptr() as *const i8, 0)
        }
        pub unsafe fn GetProcAddress(module: HMODULE, name: *const i8) -> FARPROC {
            crate::engawa_dlsym(module, name)
        }
        pub unsafe fn FreeLibrary(module: HMODULE) -> BOOL {
            (crate::engawa_dlclose(module) == 0) as BOOL
        }
    }

    pub mod consoleapi {
        use crate::shared::minwindef::{BOOL, DWORD};
        use crate::um::winnt::HANDLE;
        pub unsafe fn GetConsoleMode(_h: HANDLE, _mode: *mut DWORD) -> BOOL {
            0
        }
        pub unsafe fn SetConsoleMode(_h: HANDLE, _mode: DWORD) -> BOOL {
            0
        }
    }

    pub mod processenv {
        use crate::shared::minwindef::DWORD;
        use crate::um::winnt::HANDLE;
        pub unsafe fn GetStdHandle(_n: DWORD) -> HANDLE {
            core::ptr::null_mut()
        }
    }

    pub mod wincon {
        use crate::shared::minwindef::DWORD;
        pub const ENABLE_VIRTUAL_TERMINAL_PROCESSING: DWORD = 4;
    }
}
