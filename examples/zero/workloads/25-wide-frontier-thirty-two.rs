#![no_std]

fn step(value: i32) -> i32 {
    let mut sum = 0_i32;
    let mut index = 0_i32;
    while index < 32 {
        let term = value
            .wrapping_mul(index.wrapping_add(2))
            .wrapping_add(index.wrapping_mul(2).wrapping_add(1));
        sum = sum.wrapping_add(term);
        index += 1;
    }
    sum.wrapping_mul(sum)
}

#[unsafe(no_mangle)]
pub extern "C" fn run(seed: i32, rounds: i32) -> i32 {
    let mut remaining = rounds;
    let mut state = seed;
    while remaining > 0 {
        state = step(state);
        remaining -= 1;
    }
    state
}

#[panic_handler]
fn panic(_: &core::panic::PanicInfo<'_>) -> ! {
    loop {}
}
