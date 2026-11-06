//! The wire: one byte of type, four of length (big-endian), then the bytes. Both directions, request and stream alike,
//! so there is one reader to get right.

use std::io::{self, Read, Write};

/// No frame is larger: a request is a command line and an environment, and output is sent in pieces.
pub const MAX_FRAME: usize = 4 * 1024 * 1024;

// The request, client to helper. Repeated kinds (`ARG`, `ENV`, `GROUP`, `WRITABLE`) keep their order.
pub const VERSION: u8 = b'v';
pub const OP: u8 = b'o';
pub const AGENT: u8 = b'a';
pub const ARG: u8 = b'g';
pub const CWD: u8 = b'c';
pub const ENV: u8 = b'e';
pub const GROUP: u8 = b'G';
/// `off`, `auto` or `require` (`landlock.rs`).
pub const LANDLOCK: u8 = b'l';
/// A folder, beyond its own, the agent's commands write: a declared root.
pub const WRITABLE: u8 = b'w';
pub const END: u8 = b'.';

// The stream, after the request. Client to helper:
pub const STDIN: u8 = 0;
pub const STDIN_CLOSED: u8 = 1;
// Helper to client:
pub const STDOUT: u8 = 1;
pub const STDERR: u8 = 2;
/// `code <n>` or `signal <n>`.
pub const EXIT: u8 = 3;
/// Why nothing ran — said before anything does.
pub const REFUSED: u8 = 4;
/// The command's process id, once it runs.
pub const STARTED: u8 = 5;

pub fn write_frame(out: &mut impl Write, kind: u8, payload: &[u8]) -> io::Result<()> {
    if payload.len() > MAX_FRAME {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "frame too large"));
    }
    let mut head = [0u8; 5];
    head[0] = kind;
    head[1..].copy_from_slice(&(payload.len() as u32).to_be_bytes());
    out.write_all(&head)?;
    out.write_all(payload)?;
    out.flush()
}

/// The next frame, or `None` at a clean end of stream (nothing of a frame read yet).
pub fn read_frame(input: &mut impl Read) -> io::Result<Option<(u8, Vec<u8>)>> {
    let mut head = [0u8; 5];
    let mut got = 0;
    while got < head.len() {
        match input.read(&mut head[got..])? {
            0 if got == 0 => return Ok(None),
            0 => return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "a frame cut short")),
            n => got += n,
        }
    }
    let len = u32::from_be_bytes([head[1], head[2], head[3], head[4]]) as usize;
    if len > MAX_FRAME {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "frame too large"));
    }
    let mut payload = vec![0u8; len];
    input.read_exact(&mut payload)?;
    Ok(Some((head[0], payload)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_frame_reads_back_as_written() {
        let mut wire = Vec::new();
        write_frame(&mut wire, ARG, b"ls").unwrap();
        write_frame(&mut wire, END, b"").unwrap();
        let mut input = wire.as_slice();
        assert_eq!(read_frame(&mut input).unwrap(), Some((ARG, b"ls".to_vec())));
        assert_eq!(read_frame(&mut input).unwrap(), Some((END, Vec::new())));
        assert_eq!(read_frame(&mut input).unwrap(), None);
    }

    #[test]
    fn a_frame_cut_short_or_too_large_is_an_error_not_a_frame() {
        let mut short: &[u8] = &[ARG, 0, 0, 0, 5, b'l'];
        assert!(read_frame(&mut short).is_err());
        let mut huge: &[u8] = &[ARG, 0xff, 0xff, 0xff, 0xff];
        assert!(read_frame(&mut huge).is_err());
    }
}
