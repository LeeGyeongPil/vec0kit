# 보안 정책 / Security policy

보안 취약점을 발견하셨다면 **공개 이슈 대신** 이 레포의 **Security → Report a vulnerability**(비공개 취약점 신고)로 알려 주세요. 확인 후 답변드리고, 고친 버전을 릴리스하면서 함께 안내합니다.

If you find a security issue, please **do not open a public issue**. Use **Security → Report a vulnerability** in this repository to report it privately. We will reply after checking and announce the fix with a release.

vec0kit은 네트워크 포트를 열지 않습니다. `--reembed openai` 를 쓸 때만 문서 본문을 `VEC0KIT_EMBED_URL` 주소로 보내므로, 신뢰하는 엔드포인트만 사용하세요. / vec0kit opens no network port. Only with `--reembed openai` does it send document text to the URL in `VEC0KIT_EMBED_URL`, so use a trusted endpoint.
