#![no_std]

#[unsafe(no_mangle)]
pub extern "C" fn run(seed: i32, rounds: i32) -> i32 {
    let targets = [2.0_f32, 3.0, 5.0, 7.0];
    let mut guesses = [
        (seed as f32).abs().max(1.0),
        (seed.wrapping_add(1) as f32).abs().max(1.0),
        (seed.wrapping_add(2) as f32).abs().max(1.0),
        (seed.wrapping_add(3) as f32).abs().max(1.0),
    ];
    let mut remaining = rounds;
    while remaining > 0 {
        let mut lane = 0;
        while lane < guesses.len() {
            guesses[lane] = (guesses[lane] + targets[lane] / guesses[lane]) / 2.0;
            lane += 1;
        }
        remaining -= 1;
    }
    (guesses[0] as i32)
        .wrapping_add((guesses[1] as i32).wrapping_mul(3))
        .wrapping_add((guesses[2] as i32).wrapping_mul(5))
        .wrapping_add((guesses[3] as i32).wrapping_mul(7))
}

#[panic_handler]
fn panic(_: &core::panic::PanicInfo<'_>) -> ! {
    loop {}
}
