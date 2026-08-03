#![no_std]

fn stage0(value: i32) -> i32 {
    let mixed = value.wrapping_add(78);
    mixed
        .wrapping_mul(mixed)
        .wrapping_mul(3)
        .wrapping_add(mixed.wrapping_mul(5))
        .wrapping_add(17)
}

fn stage1(value: i32) -> i32 {
    stage0(value).wrapping_mul(3).wrapping_add(7)
}
fn stage2(value: i32) -> i32 {
    stage1(value).wrapping_mul(3).wrapping_add(7)
}
fn stage3(value: i32) -> i32 {
    stage2(value).wrapping_mul(3).wrapping_add(7)
}
fn stage4(value: i32) -> i32 {
    stage3(value).wrapping_mul(3).wrapping_add(7)
}
fn stage5(value: i32) -> i32 {
    stage4(value).wrapping_mul(3).wrapping_add(7)
}
fn stage6(value: i32) -> i32 {
    stage5(value).wrapping_mul(3).wrapping_add(7)
}
fn stage7(value: i32) -> i32 {
    stage6(value).wrapping_mul(3).wrapping_add(7)
}
fn stage8(value: i32) -> i32 {
    stage7(value).wrapping_mul(3).wrapping_add(7)
}
fn stage9(value: i32) -> i32 {
    stage8(value).wrapping_mul(3).wrapping_add(7)
}
fn stage10(value: i32) -> i32 {
    stage9(value).wrapping_mul(3).wrapping_add(7)
}
fn stage11(value: i32) -> i32 {
    stage10(value).wrapping_mul(3).wrapping_add(7)
}
fn stage12(value: i32) -> i32 {
    stage11(value).wrapping_mul(3).wrapping_add(7)
}

fn step(value: i32) -> i32 {
    stage12(value)
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
