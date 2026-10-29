//! winapi 0.3 の代わり (Cargo.toml を参照)。DLL は読めないので LoadLibraryW は失敗を返す。
#![allow(non_snake_case, non_camel_case_types, clippy::missing_safety_doc)]

use core::ffi::c_void;

extern "C" {
    fn malloc(size: usize) -> *mut c_void;
    fn calloc(n: usize, size: usize) -> *mut c_void;
    fn free(ptr: *mut c_void);
    fn malloc_usable_size(ptr: *mut c_void) -> usize;
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
    }
}

pub mod um {
    pub mod winnt {
        pub type HANDLE = *mut core::ffi::c_void;
        pub type LPCWSTR = *const u16;
        pub type LPCSTR = *const i8;
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
        use crate::shared::minwindef::{BOOL, FARPROC, HMODULE};
        pub unsafe fn LoadLibraryW(_name: *const u16) -> HMODULE {
            core::ptr::null_mut()
        }
        pub unsafe fn GetProcAddress(_module: HMODULE, _name: *const i8) -> FARPROC {
            core::ptr::null_mut()
        }
        pub unsafe fn FreeLibrary(_module: HMODULE) -> BOOL {
            1
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
