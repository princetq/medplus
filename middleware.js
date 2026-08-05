import { NextResponse } from 'next/server';

export const config = {
  // Chỉ áp dụng bộ lọc này cho toàn bộ file .json và .webp trong repo
  matcher: [
    '/(.*)\\.json',
    '/(.*)\\.webp'
  ],
};

export function middleware(request) {
  const url = new URL(request.url);
  const referer = request.headers.get('referer');
  
  // Lấy tên miền hiện tại của Web App của bạn trên Vercel
  const allowedHost = url.host; 

  // Nếu không có referer (gõ URL trực tiếp) hoặc referer không đến từ trang web của bạn
  if (!referer || !referer.includes(allowedHost)) {
    // Lập tức chặn và trả về trang lỗi 403 Forbidden
    return new NextResponse(
      JSON.stringify({ error: "Access denied. Direct downloads are not allowed." }),
      { status: 403, headers: { 'content-type': 'application/json' } }
    );
  }

  // Nếu hợp lệ (yêu cầu đến từ chính Web App của bạn), cho phép tải dữ liệu/hiển thị ảnh bình thường
  return NextResponse.next();
}
