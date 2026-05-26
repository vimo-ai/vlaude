#ifndef SugarloafIOS_Bridging_Header_h
#define SugarloafIOS_Bridging_Header_h

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

void* sugarloaf_ios_create(void* ui_view, float width, float height, float scale);
bool sugarloaf_ios_render(void* handle);
void sugarloaf_ios_resize(void* handle, float width, float height);
void sugarloaf_ios_destroy(void* handle);

// Feed raw PTY output bytes into the terminal emulator for ANSI parsing.
void sugarloaf_ios_write_pty(void* handle, const uint8_t* data, size_t len);

// Resize the terminal grid (column x row dimensions).
void sugarloaf_ios_resize_grid(void* handle, uint32_t cols, uint32_t rows);

// Set render transform: user_scale multiplies auto-fit, offset_x/y in logical points.
void sugarloaf_ios_set_transform(void* handle, float user_scale, float offset_x, float offset_y);

// Get font metrics (cell width/height in logical points). Returns false on failure.
bool sugarloaf_ios_get_font_metrics(void* handle, float* out_cell_width, float* out_cell_height);

#endif
