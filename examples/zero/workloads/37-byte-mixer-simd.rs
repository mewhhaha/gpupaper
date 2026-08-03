#![no_std]

#[unsafe(no_mangle)]
pub extern "C" fn run(seed: i32, rounds: i32) -> i32 {
    let mut bytes = [0_u8; 16];
    let mut lane = 0;
    while lane < bytes.len() {
        bytes[lane] = seed.wrapping_add(lane as i32) as u8;
        lane += 1;
    }
    let mut remaining = rounds;
    while remaining > 0 {
        let previous = bytes;
        lane = 0;
        while lane < bytes.len() {
            bytes[lane] = previous[15 - lane].saturating_add(17).count_ones() as u8;
            lane += 1;
        }
        remaining -= 1;
    }
    bytes[0] as i32
}

#[panic_handler]
fn panic(_: &core::panic::PanicInfo<'_>) -> ! {
    loop {}
}
