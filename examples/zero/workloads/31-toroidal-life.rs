#![no_std]

fn generation(board: i32) -> i32 {
    let mut next_board = 0_i32;
    let mut row = 0;
    while row < 5 {
        let mut column = 0;
        while column < 5 {
            let mut live_neighbors = 0;
            let mut row_offset = -1;
            while row_offset <= 1 {
                let mut column_offset = -1;
                while column_offset <= 1 {
                    if row_offset != 0 || column_offset != 0 {
                        let neighbor_row = (row + row_offset + 5) % 5;
                        let neighbor_column = (column + column_offset + 5) % 5;
                        let neighbor_scale = 1_i32 << (neighbor_row * 5 + neighbor_column);
                        live_neighbors += board.wrapping_div(neighbor_scale).wrapping_rem(2);
                    }
                    column_offset += 1;
                }
                row_offset += 1;
            }
            let scale = 1_i32 << (row * 5 + column);
            let alive = board.wrapping_div(scale).wrapping_rem(2);
            let next_cell = if live_neighbors == 3 {
                1
            } else if live_neighbors == 2 {
                alive
            } else {
                0
            };
            next_board = next_board.wrapping_add(next_cell.wrapping_mul(scale));
            column += 1;
        }
        row += 1;
    }
    next_board
}

#[unsafe(no_mangle)]
pub extern "C" fn run(board: i32, generations: i32) -> i32 {
    let mut remaining = generations;
    let mut current_board = board;
    while remaining > 0 {
        current_board = generation(current_board);
        remaining -= 1;
    }
    current_board
}

#[panic_handler]
fn panic(_: &core::panic::PanicInfo<'_>) -> ! {
    loop {}
}
