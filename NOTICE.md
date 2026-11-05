# NOTICE — 출처와 변경 사항

이 저장소는 아래 오픈소스 프로젝트의 **파생 저작물(derivative work)** 입니다.

## 원본

- 프로젝트: `@Starp1ume/dsh-chat-mode` (DSH 채팅 / 작업 이중 모드)
- 주소: https://github.com/Starp1ume/dsh-chat-mode
- 기반 버전: v0.2.0-beta.2
- 라이선스: MIT, Copyright (c) 2026 Starp1ume
- 원본에서 가져온 것: 클라이언트 동작 로직 전체, `icon.svg`, MIT 라이선스 전문

## 변경 사항 (한국어판)

- 사용자에게 보이는 모든 문자열을 한국어로 번역 (제목 표시줄 토글, 설정 페이지, 진단 패널, 안내 띠, 토스트, 오류/이벤트 메시지)
- 한국어 UI 로케일용 `aria-label` 셀렉터 추가: `사이드바 접기`, `사이드바 열기`, `새 세션`
- 패키지 이름 `@local/dsh-chat-mode-ko`, 모듈 로더 id·슬롯 등록 id 변경
- 원본 중국어판 행(`chat-mode`)을 비활성화하는 패치 추가
- 한국어 README, 로케일 메타데이터, 패키지 설명 추가
- 출처/인용 링크가 열리지 않던 문제 수정: Host 쪽에 같은 출처 경로(`POST /chat-mode-ko/open`)를 추가하고, 웹뷰의 새 창 열기 요청(`onOpenRequested`)과 외부 사이트 이동(`will-navigate`)을 받아 OS 기본 브라우저로 엽니다.

## 고지

이 플러그인은 **DeepSeek 공식 제품이 아니며** DeepSeek AI 와 제휴·후원·보증 관계가 없습니다.
"DeepSeek" 및 관련 표장은 DeepSeek AI 에 속합니다. 사용 전에 DeepSeek 이용 약관을 직접 확인하세요.