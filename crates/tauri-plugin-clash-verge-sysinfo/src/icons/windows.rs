use super::IconData;
use std::{ffi::c_void, mem, ptr};
use windows_sys::Win32::{
    Graphics::Gdi::{
        BI_RGB, BITMAP, BITMAPINFO, BITMAPINFOHEADER, DIB_RGB_COLORS, DeleteObject, GetDC, GetDIBits, GetObjectW,
        HBITMAP, ReleaseDC,
    },
    Storage::FileSystem::FILE_ATTRIBUTE_NORMAL,
    UI::{
        Shell::{SHFILEINFOW, SHGFI_ICON, SHGFI_LARGEICON, SHGetFileInfoW},
        WindowsAndMessaging::{DestroyIcon, GetIconInfo, HICON, ICONINFO},
    },
};

pub fn icon(exe: &str) -> Option<IconData> {
    let wide: Vec<u16> = exe.encode_utf16().chain(Some(0)).collect();
    // SAFETY: `wide` is NUL terminated and `info` is a properly sized out parameter.
    let icon = unsafe {
        let mut info: SHFILEINFOW = mem::zeroed();
        let found = SHGetFileInfoW(
            wide.as_ptr(),
            FILE_ATTRIBUTE_NORMAL,
            &mut info,
            mem::size_of::<SHFILEINFOW>() as u32,
            SHGFI_ICON | SHGFI_LARGEICON,
        );
        if found == 0 || info.hIcon.is_null() {
            return None;
        }
        info.hIcon
    };
    let pixels = icon_pixels(icon);
    // SAFETY: the icon was returned by SHGetFileInfoW and is owned by us.
    unsafe { DestroyIcon(icon) };
    let (width, height, rgba) = pixels?;
    encode_png(width, height, &rgba).map(|bytes| IconData {
        mime: "image/png",
        bytes,
    })
}

fn icon_pixels(icon: HICON) -> Option<(u32, u32, Vec<u8>)> {
    // SAFETY: GDI calls receive valid handles and buffers sized from the bitmap header;
    // the bitmaps returned by GetIconInfo are released before returning.
    unsafe {
        let mut info: ICONINFO = mem::zeroed();
        if GetIconInfo(icon, &mut info) == 0 {
            return None;
        }
        let pixels = read_bitmap(info.hbmColor);
        if !info.hbmColor.is_null() {
            DeleteObject(info.hbmColor);
        }
        if !info.hbmMask.is_null() {
            DeleteObject(info.hbmMask);
        }
        pixels
    }
}

unsafe fn read_bitmap(bitmap: HBITMAP) -> Option<(u32, u32, Vec<u8>)> {
    if bitmap.is_null() {
        return None;
    }
    // SAFETY: caller guarantees `bitmap` is a valid GDI bitmap handle.
    unsafe {
        let mut header: BITMAP = mem::zeroed();
        let size = mem::size_of::<BITMAP>() as i32;
        if GetObjectW(bitmap, size, (&raw mut header).cast::<c_void>()) == 0 {
            return None;
        }
        let (width, height) = (header.bmWidth, header.bmHeight);
        if width <= 0 || height <= 0 {
            return None;
        }

        let mut bmi: BITMAPINFO = mem::zeroed();
        bmi.bmiHeader = BITMAPINFOHEADER {
            biSize: mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width,
            // Negative height requests top-down rows.
            biHeight: -height,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB,
            ..mem::zeroed()
        };
        let mut buffer = vec![0u8; width as usize * height as usize * 4];
        let dc = GetDC(ptr::null_mut());
        let lines = GetDIBits(
            dc,
            bitmap,
            0,
            height as u32,
            buffer.as_mut_ptr().cast(),
            &mut bmi,
            DIB_RGB_COLORS,
        );
        ReleaseDC(ptr::null_mut(), dc);
        if lines == 0 {
            return None;
        }

        // Icons without an alpha channel report every pixel as transparent.
        let has_alpha = buffer.as_chunks::<4>().0.iter().any(|pixel| pixel[3] != 0);
        for pixel in buffer.as_chunks_mut::<4>().0 {
            pixel.swap(0, 2);
            if !has_alpha {
                pixel[3] = u8::MAX;
            }
        }
        Some((width as u32, height as u32, buffer))
    }
}

fn encode_png(width: u32, height: u32, rgba: &[u8]) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    let mut encoder = png::Encoder::new(&mut out, width, height);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    let mut writer = encoder.write_header().ok()?;
    writer.write_image_data(rgba).ok()?;
    writer.finish().ok()?;
    Some(out)
}
