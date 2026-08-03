#![no_std]

fn shift01(value: i32) -> i32 { value.wrapping_add(1) }
fn shift02(value: i32) -> i32 { shift01(value).wrapping_add(2) }
fn shift03(value: i32) -> i32 { shift02(value).wrapping_add(3) }
fn shift04(value: i32) -> i32 { shift03(value).wrapping_add(4) }
fn shift05(value: i32) -> i32 { shift04(value).wrapping_add(5) }
fn shift06(value: i32) -> i32 { shift05(value).wrapping_add(6) }
fn shift07(value: i32) -> i32 { shift06(value).wrapping_add(7) }
fn shift08(value: i32) -> i32 { shift07(value).wrapping_add(8) }
fn shift09(value: i32) -> i32 { shift08(value).wrapping_add(9) }
fn shift10(value: i32) -> i32 { shift09(value).wrapping_add(10) }
fn shift11(value: i32) -> i32 { shift10(value).wrapping_add(11) }
fn shift12(value: i32) -> i32 { shift11(value).wrapping_add(12) }
fn step(value: i32) -> i32 {
    let mixed = shift12(value);
    mixed
        .wrapping_mul(mixed)
        .wrapping_mul(3)
        .wrapping_add(mixed.wrapping_mul(5))
        .wrapping_add(17)
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
fn panic(_: &core::panic::PanicInfo<'_>) -> ! { loop {} }
