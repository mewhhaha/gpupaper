#![no_std]

#[unsafe(no_mangle)]
pub extern "C" fn run(seed: i32, rounds: i32) -> i32 {
    let bytes = [
        seed,
        seed.wrapping_add(1),
        seed.wrapping_add(2),
        seed.wrapping_add(3),
        rounds,
        rounds.wrapping_add(1),
        rounds.wrapping_add(2),
        rounds.wrapping_add(3),
    ];
    let mut scores = [0_i32; 4];
    let mut pair = 0;
    while pair < scores.len() {
        let left = bytes[pair * 2] as i8 as i32;
        let right = bytes[pair * 2 + 1] as i8 as i32;
        scores[pair] = left * (pair as i32 * 2 + 1) + right * (pair as i32 * 2 + 2);
        pair += 1;
    }
    scores[0]
        .wrapping_abs()
        .wrapping_add(scores[1].wrapping_abs())
}

#[panic_handler]
fn panic(_: &core::panic::PanicInfo<'_>) -> ! {
    loop {}
}
