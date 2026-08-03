#![no_std]

fn step(mut state: i32) -> i32 {
    state ^= state.wrapping_shl(13);
    state ^= (state as u32).wrapping_shr(17) as i32;
    state ^ state.wrapping_shl(5)
}

#[unsafe(no_mangle)]
pub extern "C" fn run(seed: i32, rounds: i32) -> i32 {
    let mut streams = [
        seed,
        seed.wrapping_add(1),
        seed.wrapping_add(2),
        seed.wrapping_add(3),
    ];
    let mut remaining = rounds;
    while remaining > 0 {
        let mut lane = 0;
        while lane < streams.len() {
            streams[lane] = step(streams[lane]);
            lane += 1;
        }
        remaining -= 1;
    }
    streams[0]
        .wrapping_add(streams[1].wrapping_mul(3))
        .wrapping_add(streams[2].wrapping_mul(5))
        .wrapping_add(streams[3].wrapping_mul(7))
}

#[panic_handler]
fn panic(_: &core::panic::PanicInfo<'_>) -> ! {
    loop {}
}
