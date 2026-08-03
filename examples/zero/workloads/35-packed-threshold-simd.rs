#![no_std]

#[unsafe(no_mangle)]
pub extern "C" fn run(seed: i32, rounds: i32) -> i32 {
    let mut bytes = [0_u8; 16];
    let mut lane = 0;
    while lane < bytes.len() {
        bytes[lane] = seed.wrapping_add((lane % 4) as i32) as u8;
        lane += 1;
    }
    let mut remaining = rounds;
    while remaining > 0 {
        lane = 0;
        while lane < bytes.len() {
            bytes[lane] = bytes[lane].wrapping_add(17);
            lane += 1;
        }
        remaining -= 1;
    }
    let mut mask = 0_i32;
    lane = 0;
    while lane < bytes.len() {
        if bytes[lane] < 128 {
            mask |= 1 << lane;
        }
        lane += 1;
    }
    mask
}

#[panic_handler]
fn panic(_: &core::panic::PanicInfo<'_>) -> ! {
    loop {}
}
