#![no_std]

#[unsafe(no_mangle)]
pub extern "C" fn run(seed: i32, rounds: i32) -> i32 {
    let mut words = [0_i16; 8];
    let mut lane = 0;
    while lane < words.len() {
        words[lane] = seed.wrapping_add((lane % 4) as i32) as i16;
        lane += 1;
    }
    let mut remaining = rounds;
    while remaining > 0 {
        lane = 0;
        while lane < words.len() {
            words[lane] = words[lane].wrapping_mul(3).wrapping_add(7);
            lane += 1;
        }
        remaining -= 1;
    }
    let mut mask = 0_i32;
    lane = 0;
    while lane < words.len() {
        if words[lane] < 0 {
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
