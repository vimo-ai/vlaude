#ifndef SugarloafIOS_Bridging_Header_h
#define SugarloafIOS_Bridging_Header_h

#include <stdbool.h>

void* sugarloaf_ios_create(void* ui_view, float width, float height, float scale);
bool sugarloaf_ios_render(void* handle);
void sugarloaf_ios_resize(void* handle, float width, float height);
void sugarloaf_ios_destroy(void* handle);

#endif
